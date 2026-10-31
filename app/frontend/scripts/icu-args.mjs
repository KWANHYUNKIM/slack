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
