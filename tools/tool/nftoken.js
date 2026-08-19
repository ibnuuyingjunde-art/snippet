export default {
  slug: "nftoken",
  category: "tool",
  categoryLabel: "Tool",
  group: "TOOL · GITHUB",
  method: "GET",
  title: "NFToken Generator",
  description: "Generate NFToken dari nftools.aroshi.my.id. Param: plan (premium/standard/basic), count (jumlah token, max 5).",
  params: [
    { key: "plan",  label: "Plan (premium / standard / basic)" },
    { key: "count", label: "Jumlah token (default 1, max 5)" }
  ],
  output: "json",

  handler: async ({ query, fetch, json }) => {
    const SITE    = "http://nftools.aroshi.my.id"
    const PLANS   = ["premium", "standard", "basic"]
    const plan    = PLANS.includes(query?.plan) ? query.plan : PLANS[0]
    const count   = Math.min(5, Math.max(1, parseInt(query?.count || "1") || 1))

    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

    function baseHeaders(extra = {}) {
      return {
        "User-Agent":     UA,
        "Accept":         "*/*",
        "Content-Type":   "application/json",
        "Origin":         SITE,
        "Referer":        SITE + "/nftoken",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        ...extra
      }
    }

    // Pure-JS SHA-256 for PoW (no crypto module in sandbox)
    async function sha256hex(str) {
      const buf    = new TextEncoder().encode(str)
      const digest = await crypto.subtle.digest("SHA-256", buf)
      return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("")
    }

    async function solvePow(challenge, prefix = "0000") {
      for (let n = 0; n < 1000000; n++) {
        const h = await sha256hex(challenge + n)
        if (h.startsWith(prefix)) return `${challenge}:${n}`
      }
      return null
    }

    // Step 1: get session
    let session
    try {
      const r = await fetch(SITE + "/api/session", {
        method:  "POST",
        headers: baseHeaders(),
        body:    JSON.stringify({})
      })
      const d = await r.json()
      if (!d.success || !d.token) return json({ status: false, message: "Gagal buat session", raw: d }, 502)
      session = d.token
    } catch (e) {
      return json({ status: false, message: "Koneksi ke nftools gagal: " + e.message }, 502)
    }

    // Step 2: generate token(s)
    const results = []
    for (let i = 0; i < count; i++) {
      try {
        let r = await fetch(SITE + "/api/random", {
          method:  "POST",
          headers: baseHeaders({ "X-NFToken-Session": session }),
          body:    JSON.stringify({ plan })
        })
        let d = await r.json()

        // PoW challenge
        if (r.status === 403 && d.powChallenge) {
          const proof = await solvePow(d.powChallenge)
          if (!proof) { results.push({ error: "PoW gagal" }); continue }
          r = await fetch(SITE + "/api/random", {
            method:  "POST",
            headers: baseHeaders({ "X-NFToken-Session": session, "X-PoW-Proof": proof }),
            body:    JSON.stringify({ plan })
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

    const success = results.filter(r => r.url)
    return json({
      status:  success.length > 0,
      count:   success.length,
      plan,
      result:  results
    })
  }
}
