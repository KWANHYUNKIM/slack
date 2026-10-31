// ICU 메시지에서 인자 이름 집합을 뽑는다. plural/select 분기의 본문 텍스트는 인자로 보지 않는다.
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

export function icuArgs(message) {
  const names = new Set();
  const walk = (nodes) => {
    for (const node of nodes) {
      switch (node.type) {
        case TYPE.argument:
        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
          names.add(node.value);
          break;
        case TYPE.plural:
        case TYPE.select:
          names.add(node.value);
          for (const option of Object.values(node.options)) walk(option.value);
          break;
        case TYPE.tag:
          walk(node.children);
          break;
        default:
          break;
      }
    }
  };
  walk(parse(String(message), { ignoreTag: false }));
  return [...names].sort().join(',');
}

// Trans 태그 이름(<bold>, <kbd>, <strong>)만 뽑는다. 번역이 태그를 빠뜨리거나 바꾸면 Trans가 깨진다.
export function icuTags(message) {
  const names = new Set();
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === TYPE.tag) {
        names.add(node.value);
        walk(node.children);
      } else if (node.type === TYPE.plural || node.type === TYPE.select) {
        for (const option of Object.values(node.options)) walk(option.value);
      }
    }
  };
  walk(parse(String(message), { ignoreTag: false }));
  return [...names].sort().join(',');
}
