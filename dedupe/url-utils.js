export const DEFAULT_RULES = [
  {
    id: "builtin-feishu-wiki",
    name: "Feishu Wiki 忽略 cf_ 参数",
    enabled: true,
    scheme: "https",
    host: "*.feishu.cn",
    path: "/wiki/*",
    ignoreQueryParams: ["cf_*"],
    includeHash: true,
    builtIn: true
  }
];

export function isSupportedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

export function normalizeRule(rule, index = 0) {
  return {
    id: String(rule?.id || `rule-${index + 1}`),
    name: String(rule?.name || `URL 规则 ${index + 1}`),
    enabled: rule?.enabled !== false,
    scheme: String(rule?.scheme || "").replace(/:$/, "").toLowerCase(),
    host: String(rule?.host || ""),
    path: String(rule?.path || ""),
    ignoreQueryParams: Array.isArray(rule?.ignoreQueryParams)
      ? rule.ignoreQueryParams.map((item) => String(item).trim()).filter(Boolean)
      : [],
    includeHash: rule?.includeHash !== false,
    builtIn: rule?.builtIn === true
  };
}

export function matchesGlob(value, pattern, caseSensitive = false) {
  if (!pattern) {
    return true;
  }

  const escaped = String(pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const flags = caseSensitive ? "" : "i";
  return new RegExp(`^${escaped}$`, flags).test(String(value));
}

export function ruleMatchesUrl(rawUrl, inputRule) {
  if (!isSupportedUrl(rawUrl)) {
    return false;
  }

  const rule = normalizeRule(inputRule);
  if (!rule.enabled) {
    return false;
  }

  const url = new URL(rawUrl);
  const scheme = url.protocol.slice(0, -1).toLowerCase();

  return (
    (!rule.scheme || rule.scheme === scheme) &&
    matchesGlob(url.host, rule.host, false) &&
    matchesGlob(url.pathname, rule.path, true)
  );
}

function queryParameterMatches(parameterName, patternList) {
  return patternList.some((pattern) => matchesGlob(parameterName, pattern, false));
}

export function buildRuleIdentityKey(rawUrl, inputRule) {
  const rule = normalizeRule(inputRule);
  const url = new URL(rawUrl);
  const queryList = [];

  for (const [name, value] of url.searchParams.entries()) {
    if (!queryParameterMatches(name, rule.ignoreQueryParams)) {
      queryList.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }

  const queryString = queryList.length > 0 ? `?${queryList.join("&")}` : "";
  const hash = rule.includeHash ? url.hash : "";
  return `${url.protocol}//${url.host}${url.pathname}${queryString}${hash}`;
}

export function getIdentityKeys(rawUrl, ruleList) {
  if (!isSupportedUrl(rawUrl)) {
    return [];
  }

  const keyList = [`exact:${rawUrl}`];
  for (const inputRule of ruleList || []) {
    const rule = normalizeRule(inputRule);
    if (ruleMatchesUrl(rawUrl, rule)) {
      keyList.push(`rule:${rule.id}:${buildRuleIdentityKey(rawUrl, rule)}`);
    }
  }
  return keyList;
}

function getQueryValues(url, name) {
  return JSON.stringify(url.searchParams.getAll(name));
}

export function inferRuleFromUrls(rawUrlList) {
  const urlList = rawUrlList.map((item) => String(item).trim()).filter(Boolean).map((item) => {
    try {
      return new URL(item);
    } catch {
      throw new Error(`无效的 URL：${item}`);
    }
  });

  if (urlList.length < 2) {
    throw new Error("至少需要输入两个 URL。");
  }

  const first = urlList[0];
  if (urlList.some((url) => url.protocol !== first.protocol)) {
    throw new Error("样本 URL 的协议不同，无法生成同一条规则。");
  }
  if (urlList.some((url) => url.host !== first.host)) {
    throw new Error("样本 URL 的域名不同，当前生成器不会自动跨域名合并。");
  }
  if (urlList.some((url) => url.pathname !== first.pathname)) {
    throw new Error("样本 URL 的路径不同，当前生成器只自动提取查询参数规则。");
  }

  const parameterNameSet = new Set();
  for (const url of urlList) {
    for (const name of url.searchParams.keys()) {
      parameterNameSet.add(name);
    }
  }

  const ignoreQueryParamList = [...parameterNameSet].filter((name) => {
    const firstValue = getQueryValues(first, name);
    return urlList.some((url) => getQueryValues(url, name) !== firstValue);
  });

  if (ignoreQueryParamList.length === 0) {
    throw new Error("样本 URL 没有发现查询参数差异，无法提取忽略参数规则。");
  }

  return {
    id: `rule-${Date.now()}`,
    name: `${first.host}${first.pathname} 参数规则`,
    enabled: true,
    scheme: first.protocol.slice(0, -1),
    host: first.host,
    path: first.pathname,
    ignoreQueryParams: ignoreQueryParamList,
    includeHash: true,
    samples: rawUrlList.map((item) => String(item).trim())
  };
}
