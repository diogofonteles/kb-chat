#!/usr/bin/env bash
# Creates the OCI resources of kb-chat (ADR 0010) with the OCI CLI, idempotently: each
# resource is looked up by its display name first and only created when missing.
# Dry run by default: lookups are read-only and every create is printed, not run.
#   deploy/oci/provision.sh --env ~/.config/kb-chat/oci.env            # plan
#   deploy/oci/provision.sh --env ~/.config/kb-chat/oci.env --apply    # create what is missing
# Needs: the OCI CLI configured (`oci setup config`), jq. Creates, in COMPARTMENT_OCID:
#   VCN + internet gateway + route table + security list (22/80/443) + public subnet
#   VM.Standard.A1.Flex (Ubuntu 24.04 aarch64, cloud-init) + data block volume (attached)
#   reserved public IP, Object Storage bucket for backups,
#   dynamic group + policy (instance principal writes only that bucket), monthly budget alert.
# Everything stays inside the Always Free allowance with the defaults of oci.env.example.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=""
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "provision: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -f "$ENV_FILE" ] || { echo "provision: --env <oci.env> is required (see oci.env.example)" >&2; exit 2; }
# shellcheck source=/dev/null
. "$ENV_FILE"

: "${TENANCY_OCID:?}" "${COMPARTMENT_OCID:?}" "${REGION:?}" "${NAME_PREFIX:?}"
: "${OCPUS:?}" "${MEMORY_GB:?}" "${BOOT_VOLUME_GB:?}" "${DATA_VOLUME_GB:?}"
: "${OWNER_SSH_PUBLIC_KEY_FILE:?}" "${CI_SSH_PUBLIC_KEY_FILE:?}" "${SSH_SOURCE_CIDR:?}"
: "${BACKUP_BUCKET:?}" "${BUDGET_USD:?}" "${BUDGET_ALERT_EMAIL:?}"
OWNER_KEY_FILE="${OWNER_SSH_PUBLIC_KEY_FILE/#\~/$HOME}"
CI_KEY_FILE="${CI_SSH_PUBLIC_KEY_FILE/#\~/$HOME}"
[ -f "$OWNER_KEY_FILE" ] || { echo "provision: missing $OWNER_KEY_FILE" >&2; exit 2; }
[ -f "$CI_KEY_FILE" ] || { echo "provision: missing $CI_KEY_FILE" >&2; exit 2; }

# Always Free guard: refuse sizes above the allowance instead of creating billable resources.
# Positive integers first: "3.0" or "2.5" would make the numeric test error out and pass.
for name in OCPUS MEMORY_GB BOOT_VOLUME_GB DATA_VOLUME_GB BUDGET_USD; do
  # At most 4 digits: bigger values are wrong anyway and would overflow shell arithmetic.
  if ! [[ "${!name}" =~ ^[1-9][0-9]{0,3}$ ]]; then
    echo "provision: $name must be an integer from 1 to 9999 (got '${!name}')" >&2
    exit 2
  fi
done
if [ "$BOOT_VOLUME_GB" -lt 47 ] || [ "$DATA_VOLUME_GB" -lt 50 ]; then
  echo "provision: the boot volume needs at least 47 GB and a block volume at least 50 GB" >&2
  exit 2
fi
if [ "$OCPUS" -gt 2 ] || [ "$MEMORY_GB" -gt 12 ] || [ $((BOOT_VOLUME_GB + DATA_VOLUME_GB)) -gt 200 ]; then
  echo "provision: OCPUS<=2, MEMORY_GB<=12 and boot+data<=200 GB keep this inside Always Free" >&2
  exit 2
fi

OCI=(oci --region "$REGION")
SHAPE="VM.Standard.A1.Flex"
VCN_CIDR="10.42.0.0/16"
SUBNET_CIDR="10.42.1.0/24"

say() { printf '%s\n' "$*"; }
plan() { say "  would create: $*" >&2; }

# Runs a create command, or prints it in a dry run. Prints the new OCID when applied.
create() {
  local what="$1"
  shift
  if [ "$APPLY" -eq 0 ]; then
    plan "$what"
    echo "dry-run-$what"
    return 0
  fi
  # Most resources expose data.id; a few (notification topics) name it differently.
  "${OCI[@]}" "$@" --query "${CREATE_QUERY:-data.id}" --raw-output
}

# First OCID whose display name matches, or empty. (JMESPath literals use backticks.)
# shellcheck disable=SC2016
find_id() {
  "${OCI[@]}" "$@" --all --query 'data[?"lifecycle-state" != `TERMINATED`] | [0].id' --raw-output 2>/dev/null | grep '^ocid' || true
}

say "kb-chat OCI provisioning ($([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY RUN)) in $REGION"

# --- Network -------------------------------------------------------------------------
say "network:"
vcn_id="$(find_id network vcn list --compartment-id "$COMPARTMENT_OCID" --display-name "$NAME_PREFIX-vcn")"
if [ -z "$vcn_id" ]; then
  vcn_id="$(create "vcn $NAME_PREFIX-vcn $VCN_CIDR" network vcn create --compartment-id "$COMPARTMENT_OCID" \
    --display-name "$NAME_PREFIX-vcn" --cidr-blocks "[\"$VCN_CIDR\"]" --dns-label kbchat --wait-for-state AVAILABLE)"
else say "  exists: VCN ($vcn_id)"; fi

igw_id="$(find_id network internet-gateway list --compartment-id "$COMPARTMENT_OCID" --vcn-id "$vcn_id" --display-name "$NAME_PREFIX-igw")"
if [ -z "$igw_id" ]; then
  igw_id="$(create "internet gateway $NAME_PREFIX-igw" network internet-gateway create --compartment-id "$COMPARTMENT_OCID" \
    --vcn-id "$vcn_id" --display-name "$NAME_PREFIX-igw" --is-enabled true --wait-for-state AVAILABLE)"
else say "  exists: internet gateway ($igw_id)"; fi

rt_id="$(find_id network route-table list --compartment-id "$COMPARTMENT_OCID" --vcn-id "$vcn_id" --display-name "$NAME_PREFIX-rt")"
if [ -z "$rt_id" ]; then
  rt_id="$(create "route table $NAME_PREFIX-rt (0.0.0.0/0 -> igw)" network route-table create --compartment-id "$COMPARTMENT_OCID" \
    --vcn-id "$vcn_id" --display-name "$NAME_PREFIX-rt" \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$igw_id\"}]" \
    --wait-for-state AVAILABLE)"
else say "  exists: route table ($rt_id)"; fi

# Stateful ingress: SSH (keys only) from SSH_SOURCE_CIDR, HTTP/HTTPS (and HTTP/3) from anywhere.
ingress="$(jq -cn --arg ssh "$SSH_SOURCE_CIDR" '[
  {source:$ssh, protocol:"6", tcpOptions:{destinationPortRange:{min:22,max:22}}, description:"ssh"},
  {source:"0.0.0.0/0", protocol:"6", tcpOptions:{destinationPortRange:{min:80,max:80}}, description:"http (acme, redirect)"},
  {source:"0.0.0.0/0", protocol:"6", tcpOptions:{destinationPortRange:{min:443,max:443}}, description:"https"},
  {source:"0.0.0.0/0", protocol:"17", udpOptions:{destinationPortRange:{min:443,max:443}}, description:"http/3"},
  {source:"0.0.0.0/0", protocol:"1", icmpOptions:{type:3,code:4}, description:"path mtu"}
]')"
egress='[{"destination":"0.0.0.0/0","protocol":"all"}]'
sl_id="$(find_id network security-list list --compartment-id "$COMPARTMENT_OCID" --vcn-id "$vcn_id" --display-name "$NAME_PREFIX-sl")"
if [ -z "$sl_id" ]; then
  sl_id="$(create "security list $NAME_PREFIX-sl (22 from $SSH_SOURCE_CIDR; 80, 443 tcp+udp)" network security-list create \
    --compartment-id "$COMPARTMENT_OCID" --vcn-id "$vcn_id" --display-name "$NAME_PREFIX-sl" \
    --ingress-security-rules "$ingress" --egress-security-rules "$egress" --wait-for-state AVAILABLE)"
else
  say "  exists: security list ($sl_id); rules are reset to the ones above on --apply"
  if [ "$APPLY" -eq 1 ]; then
    "${OCI[@]}" network security-list update --security-list-id "$sl_id" --force \
      --ingress-security-rules "$ingress" --egress-security-rules "$egress" >/dev/null
  fi
fi

subnet_id="$(find_id network subnet list --compartment-id "$COMPARTMENT_OCID" --vcn-id "$vcn_id" --display-name "$NAME_PREFIX-subnet")"
if [ -z "$subnet_id" ]; then
  subnet_id="$(create "public subnet $NAME_PREFIX-subnet $SUBNET_CIDR" network subnet create --compartment-id "$COMPARTMENT_OCID" \
    --vcn-id "$vcn_id" --display-name "$NAME_PREFIX-subnet" --cidr-block "$SUBNET_CIDR" --dns-label web \
    --route-table-id "$rt_id" --security-list-ids "[\"$sl_id\"]" --wait-for-state AVAILABLE)"
else say "  exists: subnet ($subnet_id)"; fi

# --- Compute -------------------------------------------------------------------------
say "compute:"
ad="${AVAILABILITY_DOMAIN:-}"
if [ -z "$ad" ]; then
  ad="$("${OCI[@]}" iam availability-domain list --compartment-id "$TENANCY_OCID" --query 'data[0].name' --raw-output)"
fi
image_id="$("${OCI[@]}" compute image list --compartment-id "$COMPARTMENT_OCID" --all \
  --operating-system "Canonical Ubuntu" --operating-system-version "24.04" --shape "$SHAPE" \
  --sort-by TIMECREATED --sort-order DESC --query 'data[0].id' --raw-output)"
say "  image: latest Canonical Ubuntu 24.04 aarch64 for $SHAPE ($image_id), AD $ad"

user_data="$(mktemp)"
trap 'rm -f "$user_data"' EXIT
ci_key="$(tr -d '\n' <"$CI_KEY_FILE")"
# One public key line; the comment may hold any text but no backslash or quote.
if ! [[ "$ci_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [^\\\"]*)?$ ]]; then
  echo "provision: $CI_KEY_FILE is not a single ssh-ed25519 public key" >&2
  exit 2
fi
# Literal replacement (no sed/regex: "&" or "#" in the key comment stay as they are).
awk -v key="$ci_key" -v mark="__CI_SSH_PUBLIC_KEY__" '{
  while ((i = index($0, mark)) > 0) $0 = substr($0, 1, i - 1) key substr($0, i + length(mark))
  print
}' "$HERE/../cloud-init.yaml" >"$user_data"

instance_id="$(find_id compute instance list --compartment-id "$COMPARTMENT_OCID" --display-name "$NAME_PREFIX-vm")"
if [ -z "$instance_id" ]; then
  instance_id="$(create "instance $NAME_PREFIX-vm $SHAPE ${OCPUS} OCPU/${MEMORY_GB} GB, boot ${BOOT_VOLUME_GB} GB" \
    compute instance launch --compartment-id "$COMPARTMENT_OCID" --availability-domain "$ad" \
    --display-name "$NAME_PREFIX-vm" --shape "$SHAPE" \
    --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}" \
    --image-id "$image_id" --boot-volume-size-in-gbs "$BOOT_VOLUME_GB" \
    --subnet-id "$subnet_id" --assign-public-ip false --hostname-label kbchat \
    --ssh-authorized-keys-file "$OWNER_KEY_FILE" --user-data-file "$user_data" \
    --wait-for-state RUNNING)"
else say "  exists: instance ($instance_id); cloud-init only runs on its first boot"; fi

# Reserved public IP on the primary private IP, bound right after the launch: the subnet has
# no NAT gateway, so this address is the VM's only way out (cloud-init waits for it).
# It survives an instance rebuild and is re-bound to the new VM.
pip_name="$NAME_PREFIX-ip"
private_ip_id=""
if [[ "$instance_id" == ocid* ]]; then
  vnic_id="$("${OCI[@]}" compute vnic-attachment list --compartment-id "$COMPARTMENT_OCID" --instance-id "$instance_id" \
    --query 'data[0]."vnic-id"' --raw-output)"
  private_ip_id="$("${OCI[@]}" network private-ip list --vnic-id "$vnic_id" --query 'data[0].id' --raw-output)"
fi
pip_json="$("${OCI[@]}" network public-ip list --compartment-id "$COMPARTMENT_OCID" --scope REGION \
  --lifetime RESERVED --all --query "data[?\"display-name\" == '$pip_name'] | [0]" 2>/dev/null || true)"
pip_id="$(jq -r '.id // empty' <<<"${pip_json:-null}" 2>/dev/null || true)"
reserved="$(jq -r '."ip-address" // empty' <<<"${pip_json:-null}" 2>/dev/null || true)"
bound_to="$(jq -r '."private-ip-id" // empty' <<<"${pip_json:-null}" 2>/dev/null || true)"
if [ -z "$pip_id" ]; then
  create "reserved public IP $pip_name, bound to the VM" network public-ip create --compartment-id "$COMPARTMENT_OCID" \
    --lifetime RESERVED --display-name "$pip_name" --private-ip-id "${private_ip_id:-dry-run}" >/dev/null
  if [ "$APPLY" -eq 1 ]; then
    reserved="$("${OCI[@]}" network public-ip list --compartment-id "$COMPARTMENT_OCID" --scope REGION \
      --lifetime RESERVED --all --query "data[?\"display-name\" == '$pip_name'] | [0].\"ip-address\"" --raw-output)"
  fi
elif [ -n "$private_ip_id" ] && [ "$bound_to" != "$private_ip_id" ]; then
  say "  exists: reserved public IP $reserved, bound elsewhere; re-binding it to the VM"
  if [ "$APPLY" -eq 1 ]; then
    "${OCI[@]}" network public-ip update --public-ip-id "$pip_id" --private-ip-id "$private_ip_id" >/dev/null
  else plan "re-bind $pip_name to $private_ip_id"; fi
else say "  exists: reserved public IP $reserved"; fi

vol_id="$(find_id bv volume list --compartment-id "$COMPARTMENT_OCID" --display-name "$NAME_PREFIX-data")"
if [ -z "$vol_id" ]; then
  vol_id="$(create "block volume $NAME_PREFIX-data ${DATA_VOLUME_GB} GB" bv volume create --compartment-id "$COMPARTMENT_OCID" \
    --availability-domain "$ad" --display-name "$NAME_PREFIX-data" --size-in-gbs "$DATA_VOLUME_GB" \
    --wait-for-state AVAILABLE)"
else say "  exists: block volume ($vol_id)"; fi

attached=""
if [ "$APPLY" -eq 1 ] || [[ "$instance_id" == ocid* ]]; then
  # shellcheck disable=SC2016
  attached="$("${OCI[@]}" compute volume-attachment list --compartment-id "$COMPARTMENT_OCID" \
    --instance-id "$instance_id" --volume-id "$vol_id" --all \
    --query 'data[?"lifecycle-state" == `ATTACHED`] | [0].id' --raw-output 2>/dev/null | grep '^ocid' || true)"
fi
if [ -z "$attached" ]; then
  create "paravirtualized attachment at /dev/oracleoci/oraclevdb" compute volume-attachment attach \
    --instance-id "$instance_id" --volume-id "$vol_id" --type paravirtualized \
    --device /dev/oracleoci/oraclevdb --wait-for-state ATTACHED >/dev/null
else say "  exists: volume attachment ($attached)"; fi

# --- Backups -------------------------------------------------------------------------
say "backups:"
namespace="$("${OCI[@]}" os ns get --query data --raw-output)"
if "${OCI[@]}" os bucket get --namespace "$namespace" --bucket-name "$BACKUP_BUCKET" >/dev/null 2>&1; then
  say "  exists: bucket $BACKUP_BUCKET"
else
  create "private bucket $BACKUP_BUCKET (Standard tier)" os bucket create --namespace "$namespace" \
    --compartment-id "$COMPARTMENT_OCID" --name "$BACKUP_BUCKET" --public-access-type NoPublicAccess \
    --storage-tier Standard >/dev/null
fi

dg_name="$NAME_PREFIX-vm"
dg_id="$(find_id iam dynamic-group list --compartment-id "$TENANCY_OCID" --name "$dg_name")"
if [ -z "$dg_id" ]; then
  # By compartment, not instance id: a rebuilt VM keeps its backup rights. The compartment
  # holds only this instance.
  create "dynamic group $dg_name (instances of the kb-chat compartment)" iam dynamic-group create --compartment-id "$TENANCY_OCID" \
    --name "$dg_name" --description "kb-chat VM (instance principal for backups)" \
    --matching-rule "ALL {instance.compartment.id = '$COMPARTMENT_OCID'}" >/dev/null
else say "  exists: dynamic group $dg_name"; fi

policy_name="$NAME_PREFIX-backups"
policy_id="$(find_id iam policy list --compartment-id "$COMPARTMENT_OCID" --name "$policy_name")"
# The VM may only add and list backups: no delete, no overwrite (put uses --no-overwrite), so
# a compromised VM cannot erase them. Retention is the bucket's lifecycle policy, which the
# Object Storage service applies (it needs its own statement).
statements="$(jq -cn --arg dg "$dg_name" --arg b "$BACKUP_BUCKET" --arg c "$COMPARTMENT_OCID" --arg r "$REGION" '[
  "Allow dynamic-group \($dg) to manage objects in compartment id \($c) where all {target.bucket.name = '\''\($b)'\'', any {request.permission = '\''OBJECT_CREATE'\'', request.permission = '\''OBJECT_INSPECT'\''}}",
  "Allow service objectstorage-\($r) to manage object-family in compartment id \($c)",
  "Allow dynamic-group \($dg) to use metrics in compartment id \($c) where target.metrics.namespace = '\''kb_chat'\''"
]')"
if [ -z "$policy_id" ]; then
  create "policy $policy_name (VM: create/inspect objects of $BACKUP_BUCKET only; lifecycle service)" iam policy create \
    --compartment-id "$COMPARTMENT_OCID" --name "$policy_name" \
    --description "kb-chat VM writes its encrypted state backups" --statements "$statements" >/dev/null
else
  say "  exists: policy $policy_name; statements are reset to the ones above on --apply"
  if [ "$APPLY" -eq 1 ]; then
    "${OCI[@]}" iam policy update --policy-id "$policy_id" --statements "$statements" --version-date "" --force >/dev/null
  fi
fi

keep_days="${BACKUP_KEEP_DAYS:-30}"
[[ "$keep_days" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "provision: BACKUP_KEEP_DAYS must be an integer from 1 to 9999" >&2; exit 2; }
lifecycle="$(jq -cn --argjson d "$keep_days" '[{name: "expire-state-backups", action: "DELETE",
  timeAmount: $d, timeUnit: "DAYS", isEnabled: true, objectNameFilter: {inclusionPrefixes: ["state/"]}}]')"
if [ "$APPLY" -eq 1 ]; then
  "${OCI[@]}" os object-lifecycle-policy put --namespace "$namespace" --bucket-name "$BACKUP_BUCKET" \
    --items "$lifecycle" --force >/dev/null
  say "  lifecycle: state/ objects deleted after $keep_days days"
else plan "lifecycle policy on $BACKUP_BUCKET: delete state/ objects after $keep_days days"; fi

# Lifecycle deletion keeps running even if backups stop. The backup script posts a
# backup_success heartbeat; this absence alarm e-mails the owner when none arrived for 48 h
# (Monitoring and Notifications e-mail stay inside the free allowance).
topic_name="$NAME_PREFIX-alerts"
topic_id="$("${OCI[@]}" ons topic list --compartment-id "$COMPARTMENT_OCID" --name "$topic_name" --all \
  --query 'data[0]."topic-id"' --raw-output 2>/dev/null | grep '^ocid' || true)"
if [ -z "$topic_id" ]; then
  # A notification topic's OCID is data."topic-id", not data.id.
  topic_id="$(CREATE_QUERY='data."topic-id"' create "notification topic $topic_name" ons topic create \
    --compartment-id "$COMPARTMENT_OCID" --name "$topic_name" --description "kb-chat operational alerts")"
else say "  exists: notification topic $topic_name"; fi
[ -n "$topic_id" ] || { echo "provision: notification topic $topic_name returned no OCID" >&2; exit 1; }
# The subscription is checked on every run, so a run that stopped after the topic still gets it.
subscription_id=""
if [ "$APPLY" -eq 1 ]; then
  subscription_id="$("${OCI[@]}" ons subscription list --compartment-id "$COMPARTMENT_OCID" --topic-id "$topic_id" --all \
    --query "data[?endpoint=='$BUDGET_ALERT_EMAIL' && \"lifecycle-state\"!='DELETED'] | [0].id" --raw-output 2>/dev/null | grep '^ocid' || true)"
fi
if [ -z "$subscription_id" ]; then
  create "e-mail subscription $BUDGET_ALERT_EMAIL (confirm the e-mail Oracle sends)" ons subscription create \
    --compartment-id "$COMPARTMENT_OCID" --topic-id "$topic_id" --protocol EMAIL \
    --subscription-endpoint "$BUDGET_ALERT_EMAIL" >/dev/null
else say "  exists: e-mail subscription $BUDGET_ALERT_EMAIL"; fi
alarm_name="$NAME_PREFIX-backup-missing"
alarm_id="$(find_id monitoring alarm list --compartment-id "$COMPARTMENT_OCID" --display-name "$alarm_name")"
if [ -z "$alarm_id" ]; then
  create "alarm $alarm_name (no backup_success for 48 h)" monitoring alarm create --compartment-id "$COMPARTMENT_OCID" \
    --display-name "$alarm_name" --metric-compartment-id "$COMPARTMENT_OCID" --namespace kb_chat \
    --query-text 'backup_success[1h]{resourceId = "kb-chat-vm"}.absent(48h)' --severity CRITICAL \
    --destinations "[\"$topic_id\"]" --is-enabled true \
    --body "No kb-chat state backup for 48 h. Backups older than ${keep_days} days are deleted by the bucket lifecycle: fix it before the last one expires (docs/deploy/runbook.md)." >/dev/null
else say "  exists: alarm $alarm_name"; fi

# --- Cost guard ----------------------------------------------------------------------
say "cost guard:"
budget_id="$(find_id budgets budget budget list --compartment-id "$TENANCY_OCID" --display-name "$NAME_PREFIX-budget")"
if [ -z "$budget_id" ]; then
  # The amount is in the tenancy's billing currency.
  budget_id="$(create "budget $BUDGET_USD (billing currency)/month on the compartment" budgets budget budget create \
    --compartment-id "$TENANCY_OCID" --display-name "$NAME_PREFIX-budget" --amount "$BUDGET_USD" \
    --reset-period MONTHLY --target-type COMPARTMENT --targets "[\"$COMPARTMENT_OCID\"]")"
else say "  exists: budget $NAME_PREFIX-budget"; fi
# The alert rule is checked on every run, so a run that stopped after the budget still gets it.
rule_id=""
# shellcheck disable=SC2016
if [ "$APPLY" -eq 1 ]; then
  rule_id="$("${OCI[@]}" budgets budget alert-rule list --budget-id "$budget_id" --all \
    --query 'data[?type == `ACTUAL`] | [0].id' --raw-output 2>/dev/null | grep '^ocid' || true)"
fi
if [ -z "$rule_id" ]; then
  create "alert at 1% of actual spend -> $BUDGET_ALERT_EMAIL" budgets budget alert-rule create --budget-id "$budget_id" \
    --type ACTUAL --threshold 1 --threshold-type PERCENTAGE --recipients "$BUDGET_ALERT_EMAIL" \
    --message "kb-chat left the Always Free allowance: check the OCI cost report" >/dev/null
else say "  exists: budget alert rule (actual spend)"; fi

say ""
say "public IP: ${reserved:-<after --apply>}  namespace: $namespace"
say "next (docs/deploy/runbook.md): DNS A record -> the IP; bootstrap-vm.sh; GitHub environment"
