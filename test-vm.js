const vm = require('vm');
const fn = vm.compileFunction('return process.env.USER;');
console.log('USER:', fn());
