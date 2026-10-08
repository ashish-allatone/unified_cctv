#!/usr/bin/env python3
"""Render Kubernetes manifests for the platform from values.yaml.

  python deploy/k8s/render.py                 # prints manifests
  python deploy/k8s/render.py --check         # validates structure only

Design: stateless Deployments behind a Service + Ingress (TLS by cert-manager), relays as a StatefulSet with
one PVC each (segment buffer) and a headless Service so every pod is addressable (relay-0, relay-1 ...), ANPR
workers as a StatefulSet so each pod knows its shard from its ordinal, HPA on CPU for api/anpr, optional
KEDA ScaledObject on Kafka lag for the indexer. Data services are external (docs/ha.md).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).parent


def load_values() -> dict:
    return yaml.safe_load((HERE / "values.yaml").read_text())


def env_common(v: dict, extra: dict | None = None) -> list[dict]:
    relays = ",".join(f"relay-{i}=http://relay-{i}.relay.{v['namespace']}.svc:9997" for i in range(v["relays"]))
    rtsps = ",".join(f"relay-{i}=rtsp://relay-{i}.relay.{v['namespace']}.svc:8554" for i in range(v["relays"]))
    pbs = ",".join(f"relay-{i}=http://relay-{i}.relay.{v['namespace']}.svc:9996" for i in range(v["relays"]))
    hosts = ",".join(f"relay-{i}={v['publicHost']}" for i in range(v["relays"]))
    base = {"DATABASE_URL": v["database_url"], "BUS": "kafka", "KAFKA_BOOTSTRAP": v["kafka_bootstrap"], "ES_URL": v["es_url"],
            "API_URL": "http://api:8000", "RELAY_APIS": relays, "RELAY_RTSPS": rtsps, "RELAY_PLAYBACKS": pbs, "RELAY_PUBLIC_HOSTS": hosts,
            "RELAY_PUBLIC_BASE": f"https://{v['publicHost']}/relay", "DATA_DIR": "/data", "RECORDINGS_DIR": "/recordings",
            "OBJECT_STORAGE": "s3", "S3_ENDPOINT": v["object_storage"]["endpoint"], "S3_REGION": v["object_storage"]["region"],
            "S3_BUCKET": v["object_storage"]["bucket"], "S3_PATH_STYLE": "1", "S3_SSE": "AES256", "PII_BLUR_FACES": "1", "METRICS_PORT": "9100"}
    base.update(extra or {})
    env = [{"name": k, "value": str(val)} for k, val in base.items()]
    for secret in ("TOKEN_SECRET", "INTERNAL_SECRET", "RELAY_INTERNAL_PASS", "S3_ACCESS_KEY", "S3_SECRET_KEY", "POLICE_ONVIF_PASS", "MUNI_API_PASS"):
        env.append({"name": secret, "valueFrom": {"secretKeyRef": {"name": "uvp-secrets", "key": secret.lower().replace("_", "-")}}})
    env.append({"name": "RELAY_INTERNAL_USER", "value": "uvp-internal"})
    return env


def image_for(v: dict, name: str, spec: dict | None = None) -> str:
    if spec and spec.get("gpu"):
        return v["imageGpu"]
    if v.get("image"):                       # legacy single image
        return v["image"]
    return f"{v['registry']}/uvp-{name}:{v['tag']}"


def probes(name: str, ports: list[int] | None) -> dict:
    if name == "api":
        return {"livenessProbe": {"httpGet": {"path": "/healthz", "port": 8000}, "initialDelaySeconds": 20, "periodSeconds": 15},
                "readinessProbe": {"httpGet": {"path": "/readyz", "port": 8000}, "initialDelaySeconds": 10, "periodSeconds": 10, "failureThreshold": 3},
                "startupProbe": {"httpGet": {"path": "/healthz", "port": 8000}, "periodSeconds": 5, "failureThreshold": 36}}
    port = (ports or [9100])[-1]
    return {"livenessProbe": {"httpGet": {"path": "/metrics", "port": port}, "initialDelaySeconds": 30, "periodSeconds": 30},
            "startupProbe": {"httpGet": {"path": "/metrics", "port": port}, "periodSeconds": 10, "failureThreshold": 30}}


def deployment(v: dict, name: str, cmd: list[str], spec: dict, env_extra: dict | None = None, ports: list[int] | None = None,
               volumes: bool = True) -> dict:
    image = image_for(v, name, spec)
    c = {"name": name, "image": image, "command": cmd, "env": env_common(v, env_extra), **probes(name, ports),
         "resources": {"requests": {"cpu": spec.get("cpu", "250m"), "memory": spec.get("memory", "512Mi")},
                       "limits": {"cpu": spec.get("cpu", "250m"), "memory": spec.get("memory", "512Mi")}},
         "ports": [{"containerPort": p} for p in (ports or [9100])],
         "volumeMounts": [{"name": "config", "mountPath": "/app/config", "readOnly": True}]}
    if volumes:
        c["volumeMounts"] += [{"name": "data", "mountPath": "/data"}, {"name": "recordings", "mountPath": "/recordings", "readOnly": True}]
    if spec.get("gpu"):
        c["resources"]["limits"]["nvidia.com/gpu"] = 1
    pod = {"containers": [c], "volumes": [{"name": "config", "configMap": {"name": "uvp-config"}}]}
    if v.get("imagePullSecret"):
        pod["imagePullSecrets"] = [{"name": v["imagePullSecret"]}]
    if volumes:
        pod["volumes"] += [{"name": "data", "persistentVolumeClaim": {"claimName": "uvp-data"}},
                           {"name": "recordings", "persistentVolumeClaim": {"claimName": "uvp-recordings"}}]
    return {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": name, "namespace": v["namespace"], "labels": {"app": name}},
            "spec": {"replicas": spec.get("replicas", 1), "selector": {"matchLabels": {"app": name}},
                     "template": {"metadata": {"labels": {"app": name}, "annotations": {"prometheus.io/scrape": "true", "prometheus.io/port": str((ports or [9100])[-1])}},
                                  "spec": pod}}}


def render(v: dict) -> list[dict]:
    ns = v["namespace"]
    docs: list[dict] = [{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": ns}}]
    docs.append({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "uvp-config", "namespace": ns},
                 "data": {f: (HERE.parent.parent / "config" / f).read_text() for f in
                          ("sources.yaml", "users.yaml", "rules.yaml", "auth.yaml", "analytics.yaml", "hotlists.yaml", "notify.yaml",
                           "tenants.yaml", "vendors.yaml", "mediamtx.yml")}})
    docs.append({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "uvp-secrets", "namespace": ns}, "type": "Opaque",
                 "stringData": {k: "CHANGE-ME" for k in ("token-secret", "internal-secret", "relay-internal-pass", "s3-access-key",
                                                          "s3-secret-key", "police-onvif-pass", "muni-api-pass")}})
    for name, size in (("uvp-data", "50Gi"), ("uvp-recordings", f"{v['relayRecordingsGb'] * v['relays']}Gi")):
        docs.append({"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": name, "namespace": ns},
                     "spec": {"accessModes": ["ReadWriteMany"], "storageClassName": v["storageClass"], "resources": {"requests": {"storage": size}}}})
    # api
    docs.append(deployment(v, "api", ["python", "-m", "uvicorn", "uvp.services.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"],
                           v["api"], {"METRICS_PORT": "0"}, ports=[8000]))
    docs.append({"apiVersion": "v1", "kind": "Service", "metadata": {"name": "api", "namespace": ns},
                 "spec": {"selector": {"app": "api"}, "ports": [{"port": 8000, "targetPort": 8000}]}})
    docs.append({"apiVersion": "autoscaling/v2", "kind": "HorizontalPodAutoscaler", "metadata": {"name": "api", "namespace": ns},
                 "spec": {"scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": "api"}, "minReplicas": v["api"]["replicas"],
                          "maxReplicas": v["api"]["maxReplicas"], "metrics": [{"type": "Resource", "resource": {"name": "cpu", "target": {"type": "Utilization", "averageUtilization": 70}}}]}})
    # stateless workers
    for name, mod, spec in (("adapters", "adapter_service", v["adapters"]), ("indexer", "indexer", v["indexer"]),
                            ("archiver", "archiver", v["archiver"]), ("analytics", "analytics_worker", v["analytics"]),
                            ("faces", "face_worker", v.get("faces", {"replicas": 1})), ("hotlist", "hotlist_sync", v["hotlist"])):
        docs.append(deployment(v, name, ["python", "-m", f"uvp.services.{mod}"], spec))
    # anpr shards: StatefulSet, ordinal = shard
    n = v["anpr"]["replicas"]
    anpr = deployment(v, "anpr", ["sh", "-c", f"export ANPR_SHARD=${{HOSTNAME##*-}}/{n}; exec python -m uvp.services.anpr_worker"], v["anpr"])
    anpr["kind"] = "StatefulSet"
    anpr["spec"]["serviceName"] = "anpr"
    docs.append(anpr)
    docs.append({"apiVersion": "v1", "kind": "Service", "metadata": {"name": "anpr", "namespace": ns},
                 "spec": {"clusterIP": "None", "selector": {"app": "anpr"}, "ports": [{"port": 9100}]}})
    # relays: StatefulSet with per-pod PVC
    relay = {"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {"name": "relay", "namespace": ns},
             "spec": {"serviceName": "relay", "replicas": v["relays"], "selector": {"matchLabels": {"app": "relay"}},
                      "template": {"metadata": {"labels": {"app": "relay"}},
                                   "spec": {**({"imagePullSecrets": [{"name": v["imagePullSecret"]}]} if v.get("imagePullSecret") else {}),
                                            "containers": [{"name": "mediamtx", "image": v.get("relayImage", "bluenviron/mediamtx:1.15.1-ffmpeg"),
                                                            "livenessProbe": {"httpGet": {"path": "/v3/paths/list", "port": 9997}, "initialDelaySeconds": 15, "periodSeconds": 20},
                                                            "readinessProbe": {"httpGet": {"path": "/v3/paths/list", "port": 9997}, "periodSeconds": 10},
                                                            "env": [{"name": "MTX_AUTHHTTPADDRESS", "value": "http://api:8000/internal/relay-auth"},
                                                                    {"name": "TZ", "value": "UTC"},
                                                                    {"name": "MTX_PATHDEFAULTS_RECORDPATH", "value": "/recordings/$(POD_NAME)/%path/%Y-%m-%d_%H-%M-%S-%f"},
                                                                    {"name": "POD_NAME", "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}}},
                                                                    {"name": "RELAY_INTERNAL_USER", "value": "uvp-internal"},
                                                                    {"name": "RELAY_INTERNAL_PASS", "valueFrom": {"secretKeyRef": {"name": "uvp-secrets", "key": "relay-internal-pass"}}}],
                                                            "ports": [{"containerPort": p} for p in (8554, 8889, 8888, 9997, 9996, 9998)] + [{"containerPort": 8189, "protocol": "UDP"}, {"containerPort": 8189, "protocol": "TCP"}],
                                                            "volumeMounts": [{"name": "config", "mountPath": "/mediamtx.yml", "subPath": "mediamtx.yml"},
                                                                             {"name": "recordings", "mountPath": "/recordings"}],
                                                            "resources": {"requests": {"cpu": "1", "memory": "1Gi"}, "limits": {"cpu": "4", "memory": "4Gi"}}}],
                                            "volumes": [{"name": "config", "configMap": {"name": "uvp-config"}},
                                                        {"name": "recordings", "persistentVolumeClaim": {"claimName": "uvp-recordings"}}]}}}}
    docs.append(relay)
    docs.append({"apiVersion": "v1", "kind": "Service", "metadata": {"name": "relay", "namespace": ns},
                 "spec": {"clusterIP": "None", "selector": {"app": "relay"}, "ports": [{"name": p, "port": n_} for p, n_ in (("rtsp", 8554), ("whep", 8889), ("hls", 8888), ("api", 9997), ("playback", 9996), ("metrics", 9998))]}})
    docs.append({"apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": {"name": "uvp", "namespace": ns,
                 "annotations": {"cert-manager.io/cluster-issuer": "letsencrypt", "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600"}},
                 "spec": {"tls": [{"hosts": [v["publicHost"]], "secretName": "uvp-tls"}],
                          "rules": [{"host": v["publicHost"], "http": {"paths": [
                              {"path": "/relay/webrtc", "pathType": "Prefix", "backend": {"service": {"name": "relay", "port": {"number": 8889}}}},
                              {"path": "/relay/hls", "pathType": "Prefix", "backend": {"service": {"name": "relay", "port": {"number": 8888}}}},
                              {"path": "/", "pathType": "Prefix", "backend": {"service": {"name": "api", "port": {"number": 8000}}}}]}}]}})
    if v.get("keda"):
        docs.append({"apiVersion": "keda.sh/v1alpha1", "kind": "ScaledObject", "metadata": {"name": "indexer", "namespace": ns},
                     "spec": {"scaleTargetRef": {"name": "indexer"}, "minReplicaCount": v["indexer"]["replicas"], "maxReplicaCount": 8,
                              "triggers": [{"type": "kafka", "metadata": {"bootstrapServers": v["kafka_bootstrap"], "consumerGroup": "uvp-indexer",
                                                                          "topic": "anpr.events", "lagThreshold": "500"}}]}})
    docs.append({"apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": {"name": "api", "namespace": ns},
                 "spec": {"minAvailable": 1, "selector": {"matchLabels": {"app": "api"}}}})
    return docs


def check(docs: list[dict]) -> list[str]:
    errs = []
    for d in docs:
        for k in ("apiVersion", "kind", "metadata"):
            if k not in d:
                errs.append(f"{d.get('kind')} missing {k}")
        if d["kind"] in ("Deployment", "StatefulSet"):
            spec = d["spec"]["template"]["spec"]
            if not spec.get("containers"):
                errs.append(f"{d['metadata']['name']}: no containers")
            names = {v["name"] for v in spec.get("volumes", [])}
            for c in spec["containers"]:
                for m in c.get("volumeMounts", []):
                    if m["name"] not in names:
                        errs.append(f"{d['metadata']['name']}: mount {m['name']} has no volume")
    return errs


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--no-secrets", action="store_true", help="leave out the placeholder Secret (CI: secrets are created once by hand)")
    a = ap.parse_args()
    docs = render(load_values())
    if a.no_secrets:
        docs = [d for d in docs if d["kind"] != "Secret"]
    problems = check(docs)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        sys.exit(1)
    if a.check:
        print(f"{len(docs)} manifests OK")
    else:
        print(yaml.safe_dump_all(docs, sort_keys=False))
