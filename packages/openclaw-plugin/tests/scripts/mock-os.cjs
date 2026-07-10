'use strict';

const os = require('os');

module.exports = Object.assign({}, os, {
  homedir: function () {
    return process.env.PD_TEST_HOMEDIR || os.homedir();
  },
});
