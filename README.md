# Stock Sentiment Barometer: Netlify version

News padh kar har stock ka "trust" vs "lack of trust" score (-100 se +100) banata hai.
Ye version **aapke Netlify account par** chalta hai: ek link se khulta hai, har ghante apne aap news
collect karta hai, aur Mac band ho tab bhi chalta rehta hai.
Sentiment ek signal hai jise study karna hai. Ye investment advice nahi hai.

## Pehli baar website chalu karna (lagbhag 10 minute)

1. **Netlify account banaiye:** https://app.netlify.com/signup par jaa kar Google ya email se sign up karein.
   Card nahi maangta. Free plan hi chuniye.
2. Ye folder apne Mac par kahin rakh dijiye (jaise Desktop par).
3. **`Deploy.command` par double-click** kariye.
   - Agar Mac bole "can't be opened", to file par **right-click → Open → Open** dabaiye (sirf pehli baar).
4. Pehli baar ye kuch tools download karega (2-3 minute), phir browser mein Netlify khulega.
   Wahan **Authorize** dabaiye aur Terminal window par wapas aaiye.
5. Agar "team" poochhe, to bas **Enter** dabaiye.
6. Aakhir mein **Production URL** dikhega (jaise `https://sentiment-barometer-ab12cd.netlify.app`).
   Yahi aapki website hai. Ise phone par bhi khol sakte hain.

**Admin password:** pehli baar `Deploy.command` aapse ek admin password banwayega (kam se kam 8 akshar).
Ye website ke **🔑 Manage API Keys** page ka taala hai. Password bhool gaye to `Reset-Password.command` par double-click kariye.

## 🔑 Manage API Keys (website ke left menu mein)

Saari API keys (Claude, Zerodha Kite, YouTube, Reddit...) yahin se save, test aur remove hoti hain.
Dobara deploy ki zaroorat nahi padti. **Key kabhi chat mein paste mat karna**, sirf isi page par daaliye.

1. Website kholiye → left menu mein **🔑 Manage API Keys** → admin password se login.
2. Jis service ki key daalni hai, uske box mein paste karke **Save**, phir **Test connection** dabaiye.
3. **Run now** dabane se news turant collect ho jaati hai. Warna har ghante apne aap hoti hai.

**Zerodha Kite Connect** (agar lena ho):
1. https://developers.kite.trade par app banaiye. "Redirect URL" mein wo link daaliye jo Manage API Keys page par Zerodha ke card mein dikhta hai (Copy button se).
2. App ki API key aur API secret page par Save kariye.
3. Har din ek baar **Login with Zerodha** dabaiye, kyunki Zerodha ka token roz subah 6 baje khatam ho jaata hai.
4. Login ho to dashboard ke saare prices (price search + chart) **Zerodha se real-time** aate hain. Login na ho to Yahoo se (15 min late),
   aur page par likha aata hai ki prices kahan se aa rahe hain.

Keys Netlify par encrypt (taala-band) karke rakhi jaati hain. Page par poori key dobara kabhi nahi dikhti.

## 🛒 Buy/Sell (Zerodha, Firebase relay ke through)

SEBI ke niyam se (1 April 2026) Zerodha sirf **registered static IP** se aaye API order leta hai. Netlify ka IP badalta rehta hai,
isliye order aapke Firebase/Google Cloud project ke ek chhote "relay" se jaate hain jiska IP pakka hai.

**Ek baar ka setup:**
1. https://console.cloud.google.com kholiye, upar apna **Firebase project** chuniye, phir upar-daayein **>_ (Cloud Shell)** dabaiye.
2. Neeche khule terminal mein ye paste karke Enter:
   `git clone https://github.com/nilgiri790/sentiment-barometer && bash sentiment-barometer/relay/setup.sh`
3. Aakhir mein teen cheezein dikhengi: **Static IP**, **Relay URL**, **Relay secret**. (Secret kisi ko mat bhejiye.)
4. Zerodha developer console → apni app → **Static IP** mein wo IP daaliye.
5. Website → 🔑 Manage API Keys → **Order relay (Firebase)** card mein Relay URL + secret Save → **Test connection**.
6. Google Cloud → Billing → **Budgets & alerts** mein ₹1000 ka alert laga dijiye (kharcha dekhte rehne ke liye).

**Order dena:** dashboard → Live price search → stock → **Buy/Sell** (sirf admin login ke baad dikhta hai) → quantity/daam →
**Review order** → **Haan, order bhejo**. Har order se pehle confirm screen aati hai. Limits (default: max 10 shares, max ₹25,000
ek order mein) Order relay card mein badal sakte hain. Order ka status (executed/rejected) Kite app ke Orders mein dekhiye.

## GitHub se automatic update (zip ki zaroorat nahi)

Ek baar GitHub se jodne ke baad: GitHub par naya code aate hi Netlify khud tests chalata hai aur website update kar deta hai.
Test fail ho to purani website chalti rehti hai. Setup ke steps Claude ne chat mein bataye hain (GitHub account → repo →
Claude ko access → Netlify mein "Link repository"). Uske baad `Deploy.command` ki zaroorat nahi. Wo sirf backup ke liye hai.

## Kuch badalna ho (stocks jodna etc.)

`lib/config.mjs` mein stocks ki list hai. Badalne ke baad `Deploy.command` par double-click kariye.
Har deploy mein Netlify ke kuch free credits lagte hain, isliye bina zaroorat baar-baar deploy mat kariye.

## Free plan ke baare mein

Netlify free plan mein har mahine credits milte hain. Ye khatam ho jaayein to site agle mahine tak ruk jaati hai,
**bill nahi aata**. Ye project bahut halka hai. Apne credits Netlify dashboard → **Usage** mein dekh sakte hain.

## Files (technical)
- `public/index.html`: dashboard page. `public/barometer.mjs`: score ka formula (page aur function dono yahi use karte hain).
- `netlify/functions/collect.mjs`: har ghante chalta hai (fetch → score → save).
- `netlify/functions/data.mjs`: `/api/data`, dashboard ka data.
- `netlify/functions/price.mjs`: `/api/price` aur `/api/search` (Yahoo Finance, Indian stocks ke liye ~15 min delay).
- `lib/`: config, Google News fetch, Claude/keyword scoring, pipeline. Data Netlify Blobs mein rehta hai (store `sentiment`).
- `test/`: offline tests (`npm test`).
