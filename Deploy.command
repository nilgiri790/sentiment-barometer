#!/bin/bash
# Double-click this file on a Mac. It puts the website on YOUR Netlify account.
# First time: it downloads the needed tools, asks you to log in to Netlify in the browser,
# and creates a new site. Next times: it just updates the same site.
cd "$(dirname "$0")" || exit 1
clear
echo "=== Stock Sentiment Barometer: Netlify par daalna ==="
echo

fail() {
  echo
  echo "Kuch gadbad hui: $1"
  echo "Is window ka screenshot le kar Claude ko bhejiye."
  read -r -p "Band karne ke liye Enter dabaiye."
  exit 1
}

# 1) Node.js (Netlify ke tools isi par chalte hain). Mac par na ho to sirf is folder mein download hota hai.
NODE_VER="v24.22.2"
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] 2>/dev/null; then
  :
else
  if [ ! -x .tools/node/bin/node ]; then
    case "$(uname -m)" in arm64) A=arm64 ;; *) A=x64 ;; esac
    echo "Pehli baar zaroori tools download ho rahe hain (lagbhag 50 MB)..."
    mkdir -p .tools
    curl -fL --progress-bar "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-$A.tar.gz" -o .tools/node.tgz \
      || fail "tools download nahi hue (internet check kariye)"
    tar -xzf .tools/node.tgz -C .tools && rm .tools/node.tgz && mv ".tools/node-$NODE_VER-darwin-$A" .tools/node \
      || fail "tools khul nahi paaye"
  fi
  export PATH="$PWD/.tools/node/bin:$PATH"
fi
export NPM_CONFIG_UPDATE_NOTIFIER=false

# 2) Project ke parts
REQ="$(cksum < package.json)"
if [ ! -d node_modules ] || [ "$(cat node_modules/.installed 2>/dev/null)" != "$REQ" ]; then
  echo "Zaroori parts install ho rahe hain (pehli baar 2-3 minute)..."
  npm install --no-audit --no-fund --loglevel=error || fail "parts install nahi hue (internet check kariye)"
  echo "$REQ" > node_modules/.installed
fi

echo "Code check ho raha hai..."
npm test --silent >/dev/null 2>&1 || fail "code ke test fail hue"

# 3) Netlify login (browser khulega, wahan 'Authorize' dabaiye)
if npx netlify status 2>&1 | grep -q "Not logged in"; then
  echo
  echo "Ab browser mein Netlify khulega. Login karke 'Authorize' dabaiye, phir yahan wapas aaiye."
  read -r -p "Tayyar hain? Enter dabaiye."
  npx netlify login || fail "Netlify login nahi hua"
fi

# 4) Kaunsi site? Pehle se bani "sentiment-barometer-..." site ho to usi ko update karo, warna nayi banao.
if ! { [ -f .netlify/state.json ] && grep -q siteId .netlify/state.json; }; then
  EXISTING="$(npx netlify sites:list --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s).filter(x=>/^sentiment-barometer-/.test(x.name));
    l.sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at)));if(l[0])console.log(l[0].id+" "+l[0].name)}catch{}})')"
  if [ -n "$EXISTING" ]; then
    echo "Aapki pehle wali site mili: ${EXISTING#* }  (isi ko update karenge)"
    npx netlify link --id "${EXISTING%% *}" >/dev/null || fail "purani site se jud nahi paaye"
  else
    NAME="sentiment-barometer-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 6)"
    echo "Nayi site ban rahi hai: $NAME"
    echo "(Agar 'team' poochhe to bas Enter dabaiye.)"
    npx netlify sites:create --name "$NAME" || fail "site nahi ban payi"
  fi
fi

# 5) Admin password ("Manage API Keys" page ka taala) aur keys ka encryption secret.
#    Values Netlify ki settings (environment variables) mein jaati hain, sabhi scopes ke liye.
env_val() { npx netlify env:get "$1" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s.slice(s.indexOf("{")));process.stdout.write(o[process.argv[1]]||"")}catch{}})' "$1"; }
set_env() {
  mkdir -p .netlify
  npx netlify env:set "$1" "$2" --force > .netlify/env-set.log 2>&1 || { cat .netlify/env-set.log; fail "setting $1 save nahi hui"; }
  [ -n "$(env_val "$1")" ] || { cat .netlify/env-set.log; fail "setting $1 Netlify par nahi dikh rahi"; }
}
if [ "$RESET_PASSWORD" = "1" ] || [ -z "$(env_val ADMIN_PASSWORD)" ]; then
  echo
  echo "Ab website ke 'Manage API Keys' page ke liye ek ADMIN PASSWORD banaiye."
  echo "Kam se kam 8 akshar. Type karte waqt screen par kuch nahi dikhega, ye normal hai."
  while true; do
    read -r -s -p "Password: " PW1; echo
    read -r -s -p "Dobara wahi password: " PW2; echo
    if [ "${#PW1}" -lt 8 ]; then echo "Kam se kam 8 akshar chahiye. Phir se try kariye."; continue; fi
    if [ "$PW1" != "$PW2" ]; then echo "Dono password alag hain. Phir se try kariye."; continue; fi
    break
  done
  set_env ADMIN_PASSWORD "$PW1"
  unset PW1 PW2
  echo "Password save ho gaya. Ise yaad rakhiye (ya kahin surakshit likh lijiye)."
else
  set_env ADMIN_PASSWORD "$(env_val ADMIN_PASSWORD)"   # same value again: makes sure every part of Netlify sees it
fi
KS="$(env_val KEYS_SECRET)"
set_env KEYS_SECRET "${KS:-$(openssl rand -hex 32)}"
unset KS
echo "Settings theek hain."

# 6) Deploy
echo
echo "Website update ho rahi hai..."
npx netlify deploy --prod --message "update from Mac" || fail "deploy nahi hua"

# 7) Check: kya website ko settings mil gayi?
SITE_URL="$(npx netlify status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s.slice(s.indexOf("{"))).siteData["site-url"]||"")}catch{}})')"
if [ -n "$SITE_URL" ]; then
  sleep 5
  CHECK="$(curl -s -m 20 "$SITE_URL/api/admin/status")"
  echo
  if echo "$CHECK" | grep -q '"setup":true'; then
    echo "Check: Manage API Keys page taiyaar hai. ✓"
  else
    echo "Check: website ko abhi setting nahi mili. Jawab: $CHECK"
    echo "1-2 minute baad page refresh kariye. Phir bhi 'setup baaki hai' dikhe to is window ka screenshot Claude ko bhejiye."
  fi
fi
echo
echo "Ho gaya! Upar 'Production URL' wala link aapki website hai."
echo "News turant chahiye to website par 🔑 Manage API Keys → login → Run now dabaiye."
npx netlify open:site >/dev/null 2>&1
read -r -p "Band karne ke liye Enter dabaiye."
