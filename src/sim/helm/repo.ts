/** An offline chart repository (a trimmed-down bitnami/nginx), so `helm repo add` + `install` work without a network. */

export interface RepoChart {
  name: string;
  version: string;
  appVersion: string;
  description: string;
  files: Record<string, string>;
}

export const KNOWN_REPOS: Record<string, string> = {
  bitnami: 'https://charts.bitnami.com/bitnami',
};

const nginxFiles = (version: string, appVersion: string, revision: string): Record<string, string> => ({
  'Chart.yaml': `annotations:
  category: Infrastructure
  licenses: Apache-2.0
apiVersion: v2
appVersion: ${appVersion}
description: NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache. Recommended for high-demanding sites due to its ability to provide faster content.
home: https://bitnami.com
icon: https://bitnami.com/assets/stacks/nginx/img/nginx-stack-220x234.png
keywords:
- nginx
- http
- web
- www
- reverse proxy
maintainers:
- name: Broadcom, Inc. All Rights Reserved.
  url: https://github.com/bitnami/charts
name: nginx
sources:
- https://github.com/bitnami/charts/tree/main/bitnami/nginx
version: ${version}
`,
  'values.yaml': `## @section Global parameters
## Global Docker image parameters
##
global:
  imageRegistry: ""

## @section Common parameters
##
## @param nameOverride String to partially override nginx.fullname template (will maintain the release name)
##
nameOverride: ""
## @param fullnameOverride String to fully override nginx.fullname template
##
fullnameOverride: ""

## @section NGINX parameters
## Bitnami NGINX image version
## ref: https://hub.docker.com/r/bitnami/nginx/tags/
## @param image.registry [default: REGISTRY_NAME] NGINX image registry
## @param image.repository [default: REPOSITORY_NAME/nginx] NGINX image repository
## @skip image.tag NGINX image tag (immutable tags are recommended)
##
image:
  registry: docker.io
  repository: bitnami/nginx
  tag: ${appVersion}-debian-12-${revision}
  pullPolicy: IfNotPresent

## @param replicaCount Number of NGINX replicas to deploy
##
replicaCount: 1

## @param containerPorts.http Sets http port inside NGINX container
## @param containerPorts.https Sets https port inside NGINX container
##
containerPorts:
  http: 8080
  https: 8443

## NGINX resource requests and limits
## @param resources.requests [object] The requested resources for the NGINX container
## @param resources.limits [object] The resources limits for the NGINX container
##
resources:
  requests:
    cpu: 100m
    memory: 128Mi
  limits:
    cpu: 150m
    memory: 192Mi

## @section Traffic Exposure parameters

## NGINX Service properties
##
service:
  ## @param service.type Service type
  ##
  type: LoadBalancer
  ## @param service.ports.http Service HTTP port
  ## @param service.ports.https Service HTTPS port
  ##
  ports:
    http: 80
    https: 443

## Configure the ingress resource that allows you to access the
## NGINX installation. Set up the URL
## ref: https://kubernetes.io/docs/concepts/services-networking/ingress/
##
ingress:
  ## @param ingress.enabled Set to true to enable ingress record generation
  ##
  enabled: false
  ## @param ingress.hostname Default host for the ingress resource
  ##
  hostname: nginx.local
  ## @param ingress.path The Path to Nginx. You may need to set this to '/*' in order to use this with ALB ingress controllers.
  ##
  path: /
  ## @param ingress.pathType Ingress path type
  ##
  pathType: ImplementationSpecific
  ## @param ingress.ingressClassName Set the ingerssClassName on the ingress record for k8s 1.18+
  ##
  ingressClassName: ""
`,
  'templates/_helpers.tpl': `{{/*
Return the proper NGINX image name
*/}}
{{- define "nginx.image" -}}
{{- $registry := default .Values.image.registry .Values.global.imageRegistry -}}
{{- printf "%s/%s:%s" $registry .Values.image.repository .Values.image.tag -}}
{{- end -}}

{{- define "common.names.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "common.labels.standard" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/name: {{ default .Chart.Name .Values.nameOverride }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "common.labels.matchLabels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/name: {{ default .Chart.Name .Values.nameOverride }}
{{- end -}}
`,
  'templates/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "common.names.fullname" . }}
  namespace: {{ .Release.Namespace | quote }}
  labels: {{- include "common.labels.standard" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels: {{- include "common.labels.matchLabels" . | nindent 6 }}
  template:
    metadata:
      labels: {{- include "common.labels.standard" . | nindent 8 }}
    spec:
      automountServiceAccountToken: false
      containers:
        - name: nginx
          image: {{ include "nginx.image" . }}
          imagePullPolicy: {{ .Values.image.pullPolicy | quote }}
          env:
            - name: NGINX_HTTP_PORT_NUMBER
              value: {{ .Values.containerPorts.http | quote }}
          ports:
            - name: http
              containerPort: {{ .Values.containerPorts.http }}
          readinessProbe:
            tcpSocket:
              port: http
            initialDelaySeconds: 5
            periodSeconds: 5
          resources: {{- toYaml .Values.resources | nindent 12 }}
`,
  'templates/svc.yaml': `apiVersion: v1
kind: Service
metadata:
  name: {{ include "common.names.fullname" . }}
  namespace: {{ .Release.Namespace | quote }}
  labels: {{- include "common.labels.standard" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  ports:
    - name: http
      port: {{ .Values.service.ports.http }}
      targetPort: http
  selector: {{- include "common.labels.matchLabels" . | nindent 4 }}
`,
  'templates/ingress.yaml': `{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "common.names.fullname" . }}
  namespace: {{ .Release.Namespace | quote }}
  labels: {{- include "common.labels.standard" . | nindent 4 }}
spec:
  {{- if .Values.ingress.ingressClassName }}
  ingressClassName: {{ .Values.ingress.ingressClassName | quote }}
  {{- end }}
  rules:
    - host: {{ .Values.ingress.hostname | quote }}
      http:
        paths:
          - path: {{ .Values.ingress.path }}
            pathType: {{ .Values.ingress.pathType }}
            backend:
              service:
                name: {{ include "common.names.fullname" . }}
                port:
                  name: http
{{- end }}
`,
  'templates/NOTES.txt': `CHART NAME: {{ .Chart.Name }}
CHART VERSION: {{ .Chart.Version }}
APP VERSION: {{ .Chart.AppVersion }}

** Please be patient while the chart is being deployed **
NGINX can be accessed through the following DNS name from within your cluster:

    {{ include "common.names.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local (port {{ .Values.service.ports.http }})

To access NGINX from outside the cluster, follow the steps below:
{{- if eq .Values.service.type "LoadBalancer" }}

1. Get the NGINX URL by running these commands:

  NOTE: It may take a few minutes for the LoadBalancer IP to be available.
        Watch the status with: 'kubectl get svc --namespace {{ .Release.Namespace }} -w {{ include "common.names.fullname" . }}'
{{- else }}

1. Forward a local port to the service:

    kubectl port-forward --namespace {{ .Release.Namespace }} svc/{{ include "common.names.fullname" . }} 8080:{{ .Values.service.ports.http }}
{{- end }}
`,
});

export const REPO_CHARTS: Record<string, RepoChart[]> = {
  bitnami: [
    { name: 'nginx', version: '18.2.4', appVersion: '1.27.2', description: 'NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache. Recommended for high-demanding sites due to its ability to provide faster content.', files: nginxFiles('18.2.4', '1.27.2', 'r2') },
    { name: 'nginx', version: '18.1.0', appVersion: '1.27.1', description: 'NGINX Open Source is a web server that can be also used as a reverse proxy, load balancer, and HTTP cache. Recommended for high-demanding sites due to its ability to provide faster content.', files: nginxFiles('18.1.0', '1.27.1', 'r5') },
  ],
};

/** The images the repo charts use (registered with the cluster's registry). */
export const REPO_IMAGES = ['docker.io/bitnami/nginx:1.27.2-debian-12-r2', 'docker.io/bitnami/nginx:1.27.1-debian-12-r5'];
