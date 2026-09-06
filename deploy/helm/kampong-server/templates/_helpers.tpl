{{/*
Standard chart name -- honors nameOverride if set (Helm's own boilerplate
pattern, kept minimal since this chart has no subcharts).
*/}}
{{- define "kampong-server.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Full, DNS-1123-safe release name -- release name + chart name, unless
fullnameOverride is set or the release name already contains the chart name.
*/}}
{{- define "kampong-server.fullname" -}}
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

{{/*
Chart name + version, for the app.kubernetes.io/managed-by-adjacent
helm.sh/chart label.
*/}}
{{- define "kampong-server.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels, applied to every object this chart renders.
*/}}
{{- define "kampong-server.labels" -}}
helm.sh/chart: {{ include "kampong-server.chart" . }}
{{ include "kampong-server.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels -- the stable subset a Deployment/Service match on (must
never change across a release, unlike the full label set above).
*/}}
{{- define "kampong-server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kampong-server.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
