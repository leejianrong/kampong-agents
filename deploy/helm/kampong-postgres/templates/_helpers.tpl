{{/*
Standard chart name -- honors nameOverride if set (Helm's own boilerplate
pattern, kept minimal since this chart has no subcharts).
*/}}
{{- define "kampong-postgres.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Full, DNS-1123-safe release name -- release name + chart name, unless
fullnameOverride is set or the release name already contains the chart name.
*/}}
{{- define "kampong-postgres.fullname" -}}
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
{{- define "kampong-postgres.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels, applied to every object this chart renders.
*/}}
{{- define "kampong-postgres.labels" -}}
helm.sh/chart: {{ include "kampong-postgres.chart" . }}
{{ include "kampong-postgres.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Selector labels -- the stable subset a Cluster/ObjectStore/ScheduledBackup
are identified by (kept for consistency with kampong-server's convention,
though these CRs have no selector semantics of their own).
*/}}
{{- define "kampong-postgres.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kampong-postgres.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
The name of the ObjectStore CR this chart renders (also used as the Barman
"barmanObjectName" the Cluster's plugin config and the ScheduledBackup point
at).
*/}}
{{- define "kampong-postgres.objectStoreName" -}}
{{- printf "%s-backup" (include "kampong-postgres.fullname" .) -}}
{{- end -}}

{{/*
The name of the small, chart-managed Secret holding the (non-sensitive) S3
region value -- see values.yaml's backup.objectStore.region comment for why
this exists instead of a plain string field.
*/}}
{{- define "kampong-postgres.regionSecretName" -}}
{{- printf "%s-backup-region" (include "kampong-postgres.fullname" .) -}}
{{- end -}}
