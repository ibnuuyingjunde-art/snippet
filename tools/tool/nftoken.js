export default {
  slug: "nftoken",
  category: "tool",
  categoryLabel: "Tool",
  group: "TOOL · GITHUB",
  method: "GET",
  title: "NFToken Generator",
  description: "Generate NFToken premium dari nftools.aroshi.my.id. Param: plan (premium/standard/basic), count (1-5).",
  params: [
    { key: "plan",  label: "Plan (premium / standard / basic)" },
    { key: "count", label: "Jumlah token (default 1, max 5)" }
  ],
  output: "json",

  handler: async ({ query, fetch, json }) => {
    const SITE  = "http://nftools.aroshi.my.id"
    const PLANS = ["premium", "standard", "basic"]
    const plan  = PLANS.includes(query?.plan) ? query.plan : PLANS[0]
    const count = Math.min(5, Math.max(1, parseInt(query?.count || "1") || 1))
    const UA    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

    function hdr(extra = {}) {
      return { "User-Agent": UA, "Accept": "*/*", "Content-Type": "application/json",
        "Origin": SITE, "Referer": SITE + "/nftoken",
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", ...extra }
    }

    // Pure-JS SHA-256 (no crypto module needed)
    function sha256(str) {
      function rightRotate(v, a) { return (v >>> a) | (v << (32 - a)) }
      const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
      let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19
      const bytes = []
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i)
        if (c < 128) bytes.push(c)
        else if (c < 2048) { bytes.push(192|(c>>6)); bytes.push(128|(c&63)) }
        else { bytes.push(224|(c>>12)); bytes.push(128|((c>>6)&63)); bytes.push(128|(c&63)) }
      }
      const bitLen = bytes.length * 8
      bytes.push(0x80)
      while (bytes.length % 64 !== 56) bytes.push(0)
      for (let i = 7; i >= 0; i--) bytes.push((bitLen / Math.pow(2, i*8)) & 255)
      for (let i = 0; i < bytes.length; i += 64) {
        const w = []
        for (let j = 0; j < 16; j++) w[j] = (bytes[i+j*4]<<24)|(bytes[i+j*4+1]<<16)|(bytes[i+j*4+2]<<8)|bytes[i+j*4+3]
        for (let j = 16; j < 64; j++) {
          const s0 = rightRotate(w[j-15],7)^rightRotate(w[j-15],18)^(w[j-15]>>>3)
          const s1 = rightRotate(w[j-2],17)^rightRotate(w[j-2],19)^(w[j-2]>>>10)
          w[j] = (w[j-16]+s0+w[j-7]+s1) >>> 0
        }
        let [a,b,c,d,e,f,g,h] = [h0,h1,h2,h3,h4,h5,h6,h7]
        for (let j = 0; j < 64; j++) {
          const S1 = rightRotate(e,6)^rightRotate(e,11)^rightRotate(e,25)
          const ch = (e&f)^(~e&g)
          const t1 = (h+S1+ch+K[j]+w[j]) >>> 0
          const S0 = rightRotate(a,2)^rightRotate(a,13)^rightRotate(a,22)
          const maj= (a&b)^(a&c)^(b&c)
          const t2 = (S0+maj) >>> 0
          h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0
        }
        h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0
        h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0
      }
      return [h0,h1,h2,h3,h4,h5,h6,h7].map(v=>v.toString(16).padStart(8,"0")).join("")
    }

    function solvePow(challenge, prefix = "0000") {
      for (let n = 0; n < 1000000; n++) {
        if (sha256(challenge + n).startsWith(prefix)) return `${challenge}:${n}`
      }
      return null
    }

    // Step 1: session
    let session
    try {
      const r = await fetch(SITE + "/api/session", { method: "POST", headers: hdr(), body: JSON.stringify({}) })
      const d = await r.json()
      if (!d.success || !d.token) return json({ status: false, message: "Gagal buat session", raw: d }, 502)
      session = d.token
    } catch (e) {
      return json({ status: false, message: "Koneksi ke nftools gagal: " + e.message }, 502)
    }

    // Step 2: generate
    const results = []
    for (let i = 0; i < count; i++) {
      try {
        let r = await fetch(SITE + "/api/random", {
          method: "POST", headers: hdr({ "X-NFToken-Session": session }), body: JSON.stringify({ plan })
        })
        let d = await r.json()
        if (r.status === 403 && d.powChallenge) {
          const proof = solvePow(d.powChallenge)
          if (!proof) { results.push({ error: "PoW gagal" }); continue }
          r = await fetch(SITE + "/api/random", {
            method: "POST", headers: hdr({ "X-NFToken-Session": session, "X-PoW-Proof": proof }), body: JSON.stringify({ plan })
          })
          d = await r.json()
        }
        if (d.success && d.url) {
          results.push({ plan, url: d.url, expires: d.expires, quality: d.quality, country: d.country })
        } else {
          results.push({ error: d.error || d.message || JSON.stringify(d) })
          if (/Limit harian|Terlalu/i.test(JSON.stringify(d))) break
        }
      } catch (e) {
        results.push({ error: e.message })
      }
    }

    const ok = results.filter(r => r.url)
    return json({ status: ok.length > 0, count: ok.length, plan, result: results })
  }
}
