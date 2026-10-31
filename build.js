// Builds public/news-index.json: recent headlines from the outlets in feeds.json.
// Generated from Scroll Stability's engine by scripts/export-headlines-repo.js. Edit there, not here.
const fs = require("fs");
const path = require("path");

var KEEP_HOURS = 72;
var MAX_PER_OUTLET = 80;
var FRESH_HOURS = 6;
var MIN_OUTLETS_ESTABLISHED = 3;

// ---------- RSS / Atom parsing (regex based so it also runs in service workers) ----------

var ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&([a-z]+);/gi, function (m, n) { return ENTITIES[n.toLowerCase()] || m; })
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  var m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? decode(m[1]) : "";
}

function parseFeed(xml) {
  var items = [];
  var blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    var title = tag(b, "title");
    var link = tag(b, "link");
    if (!link) {
      var href = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = href ? href[1] : "";
    }
    var date = tag(b, "pubDate") || tag(b, "dc:date") || tag(b, "published") || tag(b, "updated");
    var t = Date.parse(date);
    if (title && link) items.push({ title: title, link: link, time: isNaN(t) ? null : t });
  }
  return items;
}

// ---------- Index building ----------

// fetchText(url) -> Promise<string>. Injected so Node and browsers can each supply their own.
function buildIndex(feedsConfig, fetchText, now) {
  now = now || Date.now();
  var cutoff = now - KEEP_HOURS * 3600e3;
  var outlets = {};
  var jobs = [];
  feedsConfig.outlets.forEach(function (o) {
    outlets[o.id] = { name: o.name, lean: o.lean || null };
    o.feeds.forEach(function (url) {
      jobs.push(
        Promise.resolve()
          .then(function () { return fetchText(url); })
          .then(function (xml) { return { id: o.id, items: parseFeed(xml) }; })
          .catch(function (err) { return { id: o.id, items: [], error: url + ": " + (err && err.message) }; })
      );
    });
  });
  return Promise.all(jobs).then(function (results) {
    var seen = {};
    var perOutlet = {};
    var items = [];
    var errors = [];
    results.forEach(function (r) {
      if (r.error) errors.push(r.error);
      r.items.forEach(function (it) {
        var t = it.time || now;
        if (t < cutoff || seen[it.link]) return;
        perOutlet[r.id] = (perOutlet[r.id] || 0) + 1;
        if (perOutlet[r.id] > MAX_PER_OUTLET) return;
        seen[it.link] = 1;
        // Compact row: [title, link, outletId, minutesSinceEpoch]
        items.push([it.title, it.link, r.id, Math.round(t / 60000)]);
      });
    });
    items.sort(function (a, b) { return b[3] - a[3]; });
    return { built: new Date(now).toISOString(), outlets: outlets, items: items, errors: errors };
  });
}


async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "ScrollStabilityIndexer/1.0 (+headline index for media-literacy app)" },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

const feeds = JSON.parse(fs.readFileSync(path.join(__dirname, "feeds.json"), "utf8"));
buildIndex(feeds, fetchText).then((index) => {
  const { errors, ...publish } = index;
  fs.mkdirSync(path.join(__dirname, "public"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "public", "news-index.json"), JSON.stringify(publish));
  console.log(index.items.length + " headlines; " + errors.length + " feed errors");
  errors.forEach((e) => console.log("  " + e));
});
