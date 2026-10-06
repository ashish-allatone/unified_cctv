# Unified CCTV Kubernetes manifests — separated by component

Generated from the uploaded Kubernetes YAML.

## Structure
- 00-namespace/ — namespace
- 01-config/ — ConfigMap manifest plus embedded config files such as mediamtx.yml, sources.yaml, auth.yaml, analytics.yaml, etc.
- 02-secrets/ — uvp-secrets manifest (values preserved as provided; review before committing)
- api/ — API Deployment, Service, HPA, PDB
- adapters/ — adapter Deployment
- indexer/ — indexer Deployment
- archiver/ — archiver Deployment
- analytics/ — analytics Deployment
- hotlist/ — hotlist Deployment
- anpr/ — ANPR StatefulSet and Service
- relay/ — MediaMTX Relay StatefulSet and Service
- ingress/ — UVP Ingress

Note: The uploaded file contained 17 Kubernetes objects. It did not contain separate PostgreSQL, Kafka, Elasticsearch, PVC, or their Service manifests, so those were not invented here.
