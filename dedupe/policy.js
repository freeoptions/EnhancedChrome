import { getIdentityKeys } from './url-utils.js';

export function groupDuplicateTabs(tabList, ruleList, getUrl) {
  const parentList = tabList.map((tab, index) => index);
  const keyOwnerMap = new Map();
  function find(index) {
    if (parentList[index] !== index) parentList[index] = find(parentList[index]);
    return parentList[index];
  }
  tabList.forEach((tab, index) => {
    for (const key of getIdentityKeys(getUrl(tab), ruleList)) {
      if (keyOwnerMap.has(key)) parentList[find(index)] = find(keyOwnerMap.get(key));
      else keyOwnerMap.set(key, index);
    }
  });
  const groupMap = new Map();
  tabList.forEach((tab, index) => {
    const root = find(index);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root).push(tab);
  });
  return [...groupMap.values()];
}

export function planDuplicateClosure(tabList, protectedIdSet, compare) {
  const protectedList = tabList.filter(tab => protectedIdSet.has(tab.id)).sort(compare);
  const keepId = (protectedList[0] ?? [...tabList].sort(compare)[0])?.id;
  return {
    keepId,
    removeIdList: tabList.filter(tab => tab.id !== keepId && !protectedIdSet.has(tab.id)).map(tab => tab.id)
  };
}
