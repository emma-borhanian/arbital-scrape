let pug = require('pug')

let config = require('../config.js')

let compile =(file, defaultLocals={}) => {
  let f = pug.compileFile(file)
  return locals=>f({...defaultLocals, ...locals})
}

let rootLocals = { config:config, 'root': '' }
let subdirLocals = { config:config, 'root': '../' }

module.exports = {
  page: compile('template/page.pug', subdirLocals),
  index: compile('template/index.pug', rootLocals),
  debug: compile('template/debug.pug', rootLocals),
  debugAllMathjax: compile('template/debug-all-mathjax.pug', rootLocals),
  metadata: compile('template/metadata.pug', subdirLocals),
  metadataLink: compile('template/metadata-link.pug')
}
