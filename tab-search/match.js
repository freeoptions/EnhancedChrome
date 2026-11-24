import { match } from './vendor/pinyin-pro-3.29.5/core/match/index.mjs';

const pinyinOptions = { continuous: true, v: true };

export function matchesTabSearch(tab, keywordList) {
  const title = tab.title.toLowerCase();
  const alias = (tab.pin?.alias || '').toLowerCase();
  return keywordList.every(keyword =>
    title.includes(keyword) || alias.includes(keyword) ||
    match(title, keyword, pinyinOptions) !== null ||
    match(alias, keyword, pinyinOptions) !== null
  );
}
