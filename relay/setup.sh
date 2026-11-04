#!/bin/bash
# Run this in Google Cloud Shell (console.cloud.google.com -> >_ icon), inside your Firebase project.
# It creates: a static IP, a Cloud NAT that sends all relay traffic out through that IP,
# and the Cloud Run "kite-relay" service. Safe to run again (it skips what already exists).
set -u
REGION="asia-south1"            # Mumbai, close to Zerodha
NET="default"; SUBNET="default"
IP_NAME="kite-relay-ip"; ROUTER="kite-relay-router"; NAT="kite-relay-nat"; SERVICE="kite-relay"
HERE="$(cd "$(dirname "$0")" && pwd)"

fail() { echo; echo "❌ Kuch gadbad hui: $1"; echo "Is screen ka screenshot Claude ko bhejiye (secret wali line chhupa kar)."; exit 1; }
step() { echo; echo "▶ $1"; }

echo "=== Kite order relay setup (Google Cloud) ==="
PROJECT="$(gcloud config get-value project 2>/dev/null)"
if [ -z "$PROJECT" ]; then
  echo "Aapke projects:"; gcloud projects list --format="value(projectId,name)"
  read -r -p "Upar se apne Firebase project ka ID type kariye: " PROJECT
  gcloud config set project "$PROJECT" >/dev/null || fail "project set nahi hua"
fi
echo "Project: $PROJECT   Region: $REGION"
read -r -p "Sahi hai? Aage badhne ke liye Enter dabaiye (rokne ke liye Ctrl+C). " _

step "Zaroori Google services chalu ho rahi hain (pehli baar 1-2 minute)..."
gcloud services enable run.googleapis.com compute.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  || fail "services chalu nahi huin (kya is project par billing chalu hai?)"

step "Network check..."
gcloud compute networks describe "$NET" >/dev/null 2>&1 || gcloud compute networks create "$NET" --subnet-mode=auto || fail "network nahi bana"
for i in 1 2 3 4 5 6; do gcloud compute networks subnets describe "$SUBNET" --region "$REGION" >/dev/null 2>&1 && break; sleep 10; done
gcloud compute networks subnets describe "$SUBNET" --region "$REGION" >/dev/null 2>&1 || fail "Mumbai region ka subnet nahi mila"

step "Pakka (static) IP..."
gcloud compute addresses describe "$IP_NAME" --region "$REGION" >/dev/null 2>&1 \
  || gcloud compute addresses create "$IP_NAME" --region "$REGION" || fail "static IP nahi bana"
STATIC_IP="$(gcloud compute addresses describe "$IP_NAME" --region "$REGION" --format='value(address)')"
echo "Static IP: $STATIC_IP"

step "Cloud NAT (relay ka saara traffic isi IP se jaayega)..."
gcloud compute routers describe "$ROUTER" --region "$REGION" >/dev/null 2>&1 \
  || gcloud compute routers create "$ROUTER" --network "$NET" --region "$REGION" || fail "router nahi bana"
gcloud compute routers nats describe "$NAT" --router "$ROUTER" --region "$REGION" >/dev/null 2>&1 \
  || gcloud compute routers nats create "$NAT" --router "$ROUTER" --region "$REGION" \
       --nat-custom-subnet-ip-ranges "$SUBNET" --nat-external-ip-pool "$IP_NAME" || fail "Cloud NAT nahi bana"

step "Relay ka secret..."
SECRET="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json 2>/dev/null \
  | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  for e in d["spec"]["template"]["spec"]["containers"][0].get("env",[]):
    if e.get("name")=="RELAY_SECRET": print(e.get("value",""))
except Exception: pass')"
[ -n "$SECRET" ] || SECRET="$(openssl rand -hex 32)"

step "Relay deploy ho raha hai (pehli baar 3-5 minute)..."
gcloud run deploy "$SERVICE" --source "$HERE" --region "$REGION" --allow-unauthenticated \
  --network "$NET" --subnet "$SUBNET" --vpc-egress all-traffic \
  --max-instances 1 --memory 256Mi --cpu 1 --set-env-vars "RELAY_SECRET=$SECRET" --quiet || fail "relay deploy nahi hua"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"

step "Check: Zerodha ko kaunsa IP dikhega?"
SEEN="$(curl -s -m 20 "$URL/health" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("ip") or "")
except Exception: pass')"
if [ "$SEEN" = "$STATIC_IP" ]; then echo "✓ Relay ka traffic static IP $STATIC_IP se ja raha hai."
else echo "⚠ Relay ne IP '$SEEN' dikhaya, static IP '$STATIC_IP' hona chahiye. 2 minute baad website par 'Test connection' se dobara check kariye."; fi

cat <<MSG

==================== HO GAYA ====================
Ye teen cheezein ab use hongi (secret kisi ko mat bhejna, Claude ko bhi nahi):

1) Zerodha developer console -> aapki app -> Static IP:   $STATIC_IP
2) Website -> Manage API Keys -> "Order relay (Firebase)":
     Relay URL:     $URL
     Relay secret:  $SECRET
=================================================
MSG
