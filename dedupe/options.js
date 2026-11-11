import { inferRuleFromUrls, normalizeRule } from "./url-utils.js";

const ruleForm = document.querySelector("#rule-form");
const ruleName = document.querySelector("#rule-name");
const ruleScheme = document.querySelector("#rule-scheme");
const ruleHost = document.querySelector("#rule-host");
const rulePath = document.querySelector("#rule-path");
const ruleParams = document.querySelector("#rule-params");
const ruleIncludeHash = document.querySelector("#rule-include-hash");
const sampleUrls = document.querySelector("#sample-urls");
const analyzeButton = document.querySelector("#analyze-button");
const confirmGeneratedButton = document.querySelector("#confirm-generated-button");
const analyzeMessage = document.querySelector("#analyze-message");
const generatedPreview = document.querySelector("#generated-preview");
const rulesList = document.querySelector("#rules-list");
const rescanButton = document.querySelector("#rescan-button");
const exportRulesButton = document.querySelector("#export-rules-button");
const importRulesButton = document.querySelector("#import-rules-button");
const importRulesInput = document.querySelector("#import-rules-input");

let generatedRule = null;
let editingRuleId = null;
const submitRuleButton = ruleForm.querySelector("button[type=\"submit\"]");

function createId() {
  return globalThis.crypto?.randomUUID?.() || `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function downloadTextFile(fileName, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function readRules() {
  const data = await chrome.storage.local.get("rules");
  return Array.isArray(data.rules) ? data.rules.map(normalizeRule) : [];
}

async function writeRules(ruleList) {
  await chrome.storage.local.set({ rules: ruleList });
  await renderRules();
}

function setMessage(message, isError = false) {
  analyzeMessage.textContent = message;
  analyzeMessage.classList.toggle("error", isError);
}

function resetGeneratedPreview() {
  generatedRule = null;
  confirmGeneratedButton.disabled = true;
  generatedPreview.textContent = "";
  generatedPreview.classList.add("hidden");
}

function fillForm(rule) {
  editingRuleId = rule.id;
  ruleName.value = rule.name || "";
  ruleScheme.value = rule.scheme || "";
  ruleHost.value = rule.host || "";
  rulePath.value = rule.path || "";
  ruleParams.value = (rule.ignoreQueryParams || []).join("\n");
  ruleIncludeHash.checked = rule.includeHash !== false;
  submitRuleButton.textContent = "更新规则";
}

function collectFormRule() {
  const name = ruleName.value.trim();
  const host = ruleHost.value.trim();
  const path = rulePath.value.trim();
  if (!name || !host || !path) {
    throw new Error("规则名称、域名和路径不能为空。");
  }

  return {
    id: createId(),
    name,
    enabled: true,
    scheme: ruleScheme.value.trim().replace(/:$/, "").toLowerCase(),
    host,
    path,
    ignoreQueryParams: ruleParams.value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
    includeHash: ruleIncludeHash.checked
  };
}

function renderRules() {
  return readRules().then((ruleList) => {
    rulesList.replaceChildren();
    if (ruleList.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "还没有保存自定义规则。";
      rulesList.append(empty);
      return;
    }

    for (const rule of ruleList) {
      const item = document.createElement("div");
      item.className = "rule-item";

      const summary = document.createElement("div");
      summary.className = "rule-summary";
      const name = document.createElement("div");
      name.className = "rule-name";
      name.textContent = `${rule.name}${rule.builtIn ? "（内置）" : ""}`;
      const detail = document.createElement("div");
      detail.className = "rule-detail";
      const params = rule.ignoreQueryParams.length > 0
        ? `忽略：${rule.ignoreQueryParams.join(", ")}`
        : "不忽略查询参数";
      detail.textContent = `${rule.scheme ? `${rule.scheme}://` : ""}${rule.host}${rule.path} · ${params} · hash ${rule.includeHash ? "参与" : "忽略"}`;
      summary.append(name, detail);

      const actions = document.createElement("div");
      actions.className = "rule-actions";
      const toggleButton = document.createElement("button");
      toggleButton.className = "small-button";
      toggleButton.type = "button";
      toggleButton.textContent = rule.enabled ? "停用" : "启用";
      toggleButton.addEventListener("click", async () => {
        await writeRules(ruleList.map((itemRule) => itemRule.id === rule.id
          ? { ...itemRule, enabled: !itemRule.enabled }
          : itemRule));
      });
      actions.append(toggleButton);

      const editButton = document.createElement("button");
      editButton.className = "small-button";
      editButton.type = "button";
      editButton.textContent = "编辑";
      editButton.addEventListener("click", () => fillForm(rule));
      actions.append(editButton);

      const deleteButton = document.createElement("button");
      deleteButton.className = "small-button danger";
      deleteButton.type = "button";
      deleteButton.textContent = "删除";
      deleteButton.addEventListener("click", async () => {
        await writeRules(ruleList.filter((itemRule) => itemRule.id !== rule.id));
      });
      actions.append(deleteButton);

      item.append(summary, actions);
      rulesList.append(item);
    }
  });
}

ruleForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const rule = collectFormRule();
    const ruleList = await readRules();
    if (editingRuleId) {
      const currentRule = ruleList.find((item) => item.id === editingRuleId);
      await writeRules(ruleList.map((item) => item.id === editingRuleId
        ? { ...rule, id: editingRuleId, builtIn: currentRule?.builtIn === true }
        : item));
    } else {
      await writeRules([...ruleList, rule]);
    }
    editingRuleId = null;
    ruleForm.reset();
    ruleIncludeHash.checked = true;
    submitRuleButton.textContent = "保存规则";
    setMessage("规则已保存，当前窗口会自动重新扫描。", false);
  } catch (error) {
    setMessage(error.message, true);
  }
});

analyzeButton.addEventListener("click", () => {
  try {
    const lineList = sampleUrls.value.split("\n").map((item) => item.trim()).filter(Boolean);
    generatedRule = inferRuleFromUrls(lineList);
    generatedRule.id = createId();
    generatedPreview.textContent = JSON.stringify(generatedRule, null, 2);
    generatedPreview.classList.remove("hidden");
    confirmGeneratedButton.disabled = false;
    setMessage("已生成候选规则，请确认内容后再添加。", false);
  } catch (error) {
    resetGeneratedPreview();
    setMessage(error.message, true);
  }
});

confirmGeneratedButton.addEventListener("click", async () => {
  if (!generatedRule) {
    return;
  }
  const ruleList = await readRules();
  await writeRules([...ruleList, generatedRule]);
  setMessage("候选规则已确认并添加，当前窗口会自动重新扫描。", false);
  sampleUrls.value = "";
  resetGeneratedPreview();
});

rescanButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "RESCAN_CURRENT_WINDOW" });
  rescanButton.textContent = "已请求扫描";
  setTimeout(() => {
    rescanButton.textContent = "重新扫描当前窗口";
  }, 1200);
});

exportRulesButton.addEventListener("click", async () => {
  const ruleList = await readRules();
  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    rules: ruleList
  };
  const date = new Date().toISOString().slice(0, 10);
  downloadTextFile(`duplicate-url-rules-${date}.json`, `${JSON.stringify(exportData, null, 2)}\n`);
  setMessage(`已导出 ${ruleList.length} 条规则到浏览器默认下载目录。`, false);
});

importRulesButton.addEventListener("click", () => {
  importRulesInput.click();
});

importRulesInput.addEventListener("change", async () => {
  const file = importRulesInput.files?.[0];
  importRulesInput.value = "";
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    const cleanText = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const parsed = JSON.parse(cleanText);
    const importedItemList = Array.isArray(parsed) ? parsed : parsed?.rules;
    if (!Array.isArray(importedItemList)) {
      throw new Error("导入文件中没有找到 rules 数组。");
    }

    const importedRuleList = importedItemList.map((rule, index) => {
      if (!rule || typeof rule !== "object") {
        throw new Error(`第 ${index + 1} 条规则格式无效。`);
      }
      const normalized = normalizeRule({ ...rule, id: rule.id || createId() }, index);
      if (!normalized.host || !normalized.path) {
        throw new Error(`第 ${index + 1} 条规则缺少 host 或 path。`);
      }
      return normalized;
    });

    const mergedRuleMap = new Map((await readRules()).map((rule) => [rule.id, rule]));
    for (const rule of importedRuleList) {
      mergedRuleMap.set(rule.id, rule);
    }
    await writeRules([...mergedRuleMap.values()]);
    setMessage(`已导入 ${importedRuleList.length} 条规则；同 ID 规则已覆盖，其余规则已追加。`, false);
  } catch (error) {
    setMessage(`导入失败：${error.message}`, true);
  }
});

renderRules();
