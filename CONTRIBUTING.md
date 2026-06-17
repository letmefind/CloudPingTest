# Adding New Providers & Regions

All provider and region data lives in one file: **`assets/data.js`**

---

## Structure overview

```js
const PROVIDERS = [
  {
    id:       "aws",                    // unique key (lowercase, no spaces)
    name:     "AWS",                    // short label shown in the UI
    longName: "Amazon Web Services",    // full name (tooltip / aria)
    color:    "#FF9900",                // brand hex color for the card icon
    url:      r => `https://ec2.${r.code}.amazonaws.com/ping`,  // ping URL builder
    regions: [
      { text1: "US East",  text2: "N. Virginia", code: "us-east-1" },
      //         ↑ zone/group  ↑ city name         ↑ region identifier
    ]
  },
  // ... more providers
];
```

---

## Case 1 — Add a region to an existing provider

Open `assets/data.js`, find the provider block, and add one line to the `regions` array:

```js
// Example: adding a new AWS region
{ text1: "Asia Pacific", text2: "Thailand", code: "ap-southeast-7" },
```

| Field | What to put |
|---|---|
| `text1` | Geographic group (continent / zone): `"US East"`, `"Europe"`, `"Asia Pacific"`, `"Middle East"`, etc. |
| `text2` | City or location name: `"Frankfurt"`, `"São Paulo"`, etc. |
| `code`  | The region code exactly as the provider uses it |

### How to find the region code

| Provider | Where to look |
|---|---|
| **AWS** | [AWS Regions list](https://docs.aws.amazon.com/general/latest/gr/rande.html) |
| **Azure** | [Azure regions list](https://azure.microsoft.com/en-us/explore/global-infrastructure/geographies/) |
| **GCP** | [GCP regions & zones](https://cloud.google.com/about/locations) |
| **DigitalOcean** | [DO regions](https://docs.digitalocean.com/platform/regional-availability/) |
| **Oracle Cloud** | [OCI regions](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm) |
| **Vultr** | [Vultr locations](https://www.vultr.com/features/datacenter-locations/) |
| **Linode** | [Linode regions](https://www.linode.com/global-infrastructure/) |

---

## Case 2 — Add a completely new provider

Add a new object to the `PROVIDERS` array in `assets/data.js`.

### Template

```js
{
  id:       "myprovider",           // unique, lowercase
  name:     "MyProvider",           // shown in UI card
  longName: "My Provider Full Name",
  color:    "#123456",              // brand color
  url:      r => `https://ENDPOINT_PATTERN_HERE`,
  regions: [
    { text1: "Region Group", text2: "City Name", code: "region-code-1" },
    { text1: "Region Group", text2: "City Name", code: "region-code-2" },
  ]
}
```

### Finding the ping URL (most important step)

The app loads any URL as an image beacon and measures round-trip time. The URL just needs to respond (even a 404 counts as a valid RTT). Use the **simplest, most stable public URL** for each region.

**Known URL patterns:**

```js
// AWS
r => `https://ec2.${r.code}.amazonaws.com/ping`
// example: https://ec2.eu-central-1.amazonaws.com/ping

// Azure Blob Storage
r => `https://s8${r.code}.blob.core.windows.net/public/latency-test.json`
// example: https://s8eastus.blob.core.windows.net/public/latency-test.json

// GCP
r => `https://storage.googleapis.com/${r.code}/generate_204`
// OR per-region: depends on the GCP location slug

// DigitalOcean Spaces
r => `https://${r.code}.digitaloceanspaces.com`
// example: https://sfo3.digitaloceanspaces.com

// Vultr Object Storage
r => `https://${r.code}.vultrobjects.com`

// Hetzner
r => `https://speed.${r.code}.hetzner.com/.ping`

// Linode Object Storage
r => `https://${r.code}.linodeobjects.com`

// Oracle Cloud
r => `https://objectstorage.${r.code}.oraclecloud.com/`

// Contabo
r => `https://${r.code.toLowerCase()}.speedtest.contabo.net/`

// CoreWeave
r => `https://http.speedtest.${r.code.toLowerCase()}.coreweave.com/ping`
```

### How to verify a URL works

Open your browser DevTools (F12) → Network tab, then run this in the Console:

```js
const start = performance.now();
const img = new Image();
img.onload = img.onerror = () => console.log("RTT:", Math.round(performance.now() - start), "ms");
img.src = "https://YOUR-ENDPOINT-URL?" + Date.now();
```

If you see a number in ms → the URL works ✅  
If it hangs or throws CORS error → try another URL ❌

---

## Case 3 — Add a provider with a custom URL per region

If each region has a completely different hostname:

```js
{
  id: "myprovider",
  name: "MyProvider",
  longName: "My Provider",
  color: "#aabbcc",
  url: r => r.endpoint,   // read directly from region object
  regions: [
    { text1: "Europe",    text2: "Amsterdam",  code: "ams1", endpoint: "https://ams1.myprovider.com/ping" },
    { text1: "US East",   text2: "New York",   code: "nyc1", endpoint: "https://nyc1.myprovider.com/ping" },
    { text1: "Asia",      text2: "Singapore",  code: "sin1", endpoint: "https://sin1.myprovider.com/ping" },
  ]
}
```

---

## Quick checklist

Before submitting / committing:

- [ ] `id` is unique across all providers (check with Ctrl+F in data.js)
- [ ] `color` is a valid hex like `"#FF9900"` (with `#`, in quotes)
- [ ] `url` function returns a valid URL string (test in browser console)
- [ ] All region `code` values are correct and match what the provider uses
- [ ] No trailing commas causing parse errors (JS allows them, but double-check)
- [ ] Bump the cache-buster in `index.html`:
  ```html
  <!-- Change v=8 to v=9 (or any higher number) in these lines: -->
  <link rel="stylesheet" href="assets/styles.css?v=8">
  <script src="assets/i18n.js?v=1"></script>
  <script src="assets/data.js?v=7"></script>
  <script src="assets/app.js?v=8"></script>
  ```

---

## Full example: adding Cloudflare R2

```js
{
  id: "cloudflare",
  name: "Cloudflare",
  longName: "Cloudflare R2",
  color: "#F48120",
  url: r => `https://${r.code}.r2.cloudflarestorage.com`,
  regions: [
    { text1: "US East",      text2: "WNAM",        code: "wnam" },
    { text1: "US West",      text2: "ENAM",        code: "enam" },
    { text1: "Europe West",  text2: "WEUR",        code: "weur" },
    { text1: "Europe East",  text2: "EEUR",        code: "eeur" },
    { text1: "Asia Pacific", text2: "APAC",        code: "apac" },
    { text1: "Africa",       text2: "AFR",         code: "afr"  },
    { text1: "Middle East",  text2: "ME",          code: "me"   },
  ]
}
```

---

## Submitting changes

1. Fork the repo
2. Edit `assets/data.js`
3. Test locally: `python3 -m http.server 8000` → open `http://localhost:8000`
4. Open a Pull Request with a description of what provider/regions you added
