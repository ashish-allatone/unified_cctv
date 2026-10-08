// Unified CCTV by Allatone — Git -> Jenkins -> Docker build -> OCIR push -> OKE deploy
//
// Jenkins credentials expected:
//   ocir-creds   username/password  = "<tenancy-namespace>/<oci-user>" + auth token
//   oke-kubeconfig  secret file     = kubeconfig for the OKE cluster (or use the OCI CLI plugin)
// Parameters:
//   REGISTRY    e.g. ap-mumbai-1.ocir.io/<tenancy-namespace>
//   TAG         image tag; default = VERSION file. Use "${GIT_COMMIT[0..7]}" for per-commit tags.
//   SERVICES    space separated list to build (default: all)
//   DEPLOY      apply deploy/k8s/manifests.yaml to the cluster after the push
pipeline {
  agent any
  options { timestamps(); disableConcurrentBuilds() }
  parameters {
    string(name: 'REGISTRY', defaultValue: 'ap-mumbai-1.ocir.io/TENANCY_NAMESPACE', description: 'OCIR registry/namespace')
    string(name: 'TAG', defaultValue: '', description: 'Image tag (blank = VERSION file)')
    string(name: 'SERVICES', defaultValue: 'api indexer adapters anpr analytics faces archiver hotlist mediamtx', description: 'Services to build')
    booleanParam(name: 'DEPLOY', defaultValue: false, description: 'kubectl apply the rendered manifests to OKE')
    booleanParam(name: 'GPU', defaultValue: false, description: 'Also build the CUDA image for anpr/analytics (platform/Dockerfile.gpu)')
  }
  environment { DOCKER_BUILDKIT = '1' }
  stages {
    stage('Checkout') { steps { checkout scm } }
    stage('Tag') {
      steps { script { env.IMAGE_TAG = params.TAG ?: readFile('VERSION').trim(); echo "image tag ${env.IMAGE_TAG}" } }
    }
    stage('Test') {
      steps { sh 'python3 -m venv .venv && . .venv/bin/activate && pip install -q -r platform/requirements.txt pytest && pytest -q tests' }
    }
    stage('Build images') {
      steps {
        script {
          // every service Dockerfile builds from the repository root; they share all layers except the CMD,
          // so building them in sequence on one agent re-uses the cache (first ~10 min, then ~1 min each)
          params.SERVICES.split().each { svc ->
            def name = (svc == 'mediamtx') ? 'relay' : svc
            sh "docker build -f ${svc}/Dockerfile -t ${params.REGISTRY}/uvp-${name}:${env.IMAGE_TAG} ."
          }
          if (params.GPU) {
            sh "docker build -f platform/Dockerfile.gpu -t ${params.REGISTRY}/uvp-anpr-gpu:${env.IMAGE_TAG} ."
          }
        }
      }
    }
    stage('Push to OCIR') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'ocir-creds', usernameVariable: 'OCIR_USER', passwordVariable: 'OCIR_TOKEN')]) {
          sh 'echo "$OCIR_TOKEN" | docker login ${REGISTRY%%/*} -u "$OCIR_USER" --password-stdin'
          script {
            params.SERVICES.split().each { svc ->
              def name = (svc == 'mediamtx') ? 'relay' : svc
              sh "docker push ${params.REGISTRY}/uvp-${name}:${env.IMAGE_TAG}"
            }
            if (params.GPU) { sh "docker push ${params.REGISTRY}/uvp-anpr-gpu:${env.IMAGE_TAG}" }
          }
        }
      }
    }
    stage('Render manifests') {
      steps {
        sh """
          python3 - <<'EOF'
import re, pathlib
p = pathlib.Path('deploy/k8s/values.yaml'); s = p.read_text()
s = re.sub(r'^registry: .*$', 'registry: ${params.REGISTRY}', s, flags=re.M)
s = re.sub(r'^tag: .*$', 'tag: ${env.IMAGE_TAG}', s, flags=re.M)
s = re.sub(r'^imageGpu: .*$', 'imageGpu: ${params.REGISTRY}/uvp-anpr-gpu:${env.IMAGE_TAG}', s, flags=re.M)
s = re.sub(r'^relayImage: .*$', 'relayImage: ${params.REGISTRY}/uvp-relay:${env.IMAGE_TAG}', s, flags=re.M)
p.write_text(s)
EOF
          pip3 install -q pyyaml && python3 deploy/k8s/render.py --check && python3 deploy/k8s/render.py --no-secrets > deploy/k8s/manifests.yaml
        """
        archiveArtifacts artifacts: 'deploy/k8s/manifests.yaml', fingerprint: true
      }
    }
    stage('Deploy to OKE') {
      when { expression { params.DEPLOY } }
      steps {
        withCredentials([file(credentialsId: 'oke-kubeconfig', variable: 'KUBECONFIG')]) {
          // secrets (uvp-secrets) and the OCIR pull secret are created once by hand (DEPLOYMENT.md) and are NOT in the manifests
          sh 'kubectl apply -f deploy/k8s/manifests.yaml'
          sh 'kubectl -n unified-cctv rollout status deploy/api --timeout=300s'
          sh 'kubectl -n unified-cctv get pods -o wide'
        }
      }
    }
  }
  post { always { sh 'docker image prune -f >/dev/null 2>&1 || true' } }
}
