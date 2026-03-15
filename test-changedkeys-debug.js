// Debug script to test changedKeys logic

const oldProps = {
  Name: 'ИДЧата',
  Type: 'Number(15,0)',
  PasswordMode: false
};

const newProps = {
  Name: 'ИДЧата',
  Type: 'Number(15,0)',
  PasswordMode: true
};

const changedKeys = Object.keys(newProps).filter(
  key => newProps[key] !== oldProps[key]
);

console.log('Old props:', oldProps);
console.log('New props:', newProps);
console.log('Changed keys:', changedKeys);
console.log('Type in changedKeys?', changedKeys.includes('Type'));
