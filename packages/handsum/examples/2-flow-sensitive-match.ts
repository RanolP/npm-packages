import { handsum, HandsumSubset, type Handsum } from 'handsum';

type NumbersStr = '00' | '01' | '10' | '11';

type TNumbers = Record<NumbersStr, (val: number) => NumbersStr>;
type Numbers = Handsum<TNumbers>;
const Numbers = handsum<TNumbers>({});

function process(n: Numbers) {
  if (n['00']) return n['00'][0];
  if (n['11']) return n['11'][0];

  return n.match({
    '01': (x) => x * 2,
    '10': (x) => x * 3,
  });
}

function only0011(n: Numbers) {
  return n.match({
    '00': () => '00',
    '11': () => '11',
    _: () => 'others',
  });
}

function only0011Simpler(n: Numbers) {
  if (n['00'] || n['11']) return simpler(n);
  return 'others';
}

function simpler(n: HandsumSubset<Numbers, '00' | '11'>) {
  return n.match({
    '00': () => '00',
    '11': () => '11',
  });
}
