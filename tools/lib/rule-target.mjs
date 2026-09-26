/**
 * 判断两条 Quantumult X rewrite 的 URL 正则是否命中「同一个接口」。
 *
 * 用于跨源重复检测：两条会改写请求/响应体的规则（script-* / jsonjq-*）
 * 命中同一 URL 时，同一个 body 会被先后处理两次 —— QX 不报错，结果不可预期。
 *
 * 为什么不能用「整行文本比对」：跨源重复的真实形态是同一接口、不同正则写法。
 * 为什么不能用「分词后交集」：`api`、`https`、`homepage` 这类通用词到处都是，
 *   实测把「api.pinduoduo.com/api/alexa/homepage/hub」与
 *   「api.u51.com/liabilitygateway/api/v1/homepage/liabilityline」判成重复（假阳性）。
 * 正确判据：**域名**相同（或一方是另一方的子域）+ 至少 2 个共同的**路径词元**。
 */

const TLD = /\.(com|cn|net|org|io|tv|me|xyz|top|cc|co|info|biz|app|site|mobi|gov|edu|club|shop)$/;
/** 出现在域名里但没有区分度的词，不能作为「同一域名」的依据。 */
const GENERIC = new Set(["api", "www", "m", "mobile", "app", "static", "cdn", "img", "data", "s"]);

/**
 * 抽出正则里出现的所有域名候选。
 * 例：`^https:\/\/(spclient\.wg\.spotify\.com|.*-spclient\.spotify\.com(:443)?)\/...`
 *     -> {"spclient.wg.spotify.com", "spclient.spotify.com"}
 */
function domainsOf(pat) {
  const plain = pat.replace(/\\/g, "").toLowerCase();
  const out = new Set();
  for (const m of plain.matchAll(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/g)) {
    const d = m[0].replace(/^\.+|\.+$/g, "");
    if (TLD.test(d)) out.add(d);
  }
  return out;
}

/** 路径词元（去掉域名与通用词、长度 ≥4）。 */
function pathTokensOf(pat) {
  return new Set(
    pat
      .replace(/\\/g, "")
      .replace(/\^|\$|\(\?:|\(|\)|\?|:443|\*/g, " ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && t !== "https" && t !== "http"),
  );
}

export function ruleSig(pat) {
  const domains = domainsOf(pat);
  const pathTokens = pathTokensOf(pat);
  // 路径词元里若混入域名片段（如 amap/cainiao），去掉，避免同域不同接口互相误判
  for (const d of domains) for (const w of d.split(".")) pathTokens.delete(w);
  return { domains, pathTokens };
}

/** 两条域名是否指同一主机（相等，或一方是另一方的子域）。 */
function sameHost(a, b) {
  for (const x of a) {
    if (GENERIC.has(x.split(".")[0])) continue;
    for (const y of b) {
      if (GENERIC.has(y.split(".")[0])) continue;
      if (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)) return true;
    }
  }
  return false;
}

/**
 * 出现在路径里但区分度很低的词：它们描述「这是什么类型的资源」而非「哪个接口」，
 * 单靠它们会把不同接口判成重复（实测 mobwsa.ximalaya.com 的 tabs/v2 与
 * recommendContentV1 共享 mobile/playpage 两词，但那是两个不同接口）。
 */
const NOISE = new Set(["mobile", "playpage", "play", "page", "tabs", "list", "index", "home",
  "main", "get", "query", "info", "detail", "config", "user", "v1", "v2", "v3", "api"]);

export function sameTarget(a, b) {
  if (!sameHost(a.domains, b.domains)) return false;
  const shared = [...a.pathTokens].filter((t) => b.pathTokens.has(t));
  const distinctive = shared.filter((t) => !NOISE.has(t));
  // 判据：至少 2 个「有区分度」的共同词元。
  // 只用总数会误报（见上面 NOISE 的例子）；只用 1 个又容易撞通用词。
  return distinctive.length >= 2;
}
