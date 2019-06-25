let pug = require('pug')

let config = require('../config.js')
let lib = require('./lib.js')

let compile =(file, defaultLocals={}) => {
  let f = pug.compileFile(file)
  return locals=>f({...defaultLocals, ...locals})
}

let locals = {lib:lib, config:config}
let rootLocals = { ...locals, 'root': '' }
let subdirLocals = { ...locals, 'root': '../' }

module.exports = {
  page: compile('template/page.pug', subdirLocals),
  index: compile('template/index.pug', rootLocals),
  debug: compile('template/debug.pug', rootLocals),
  debugAllMathjax: compile('template/debug-all-mathjax.pug', rootLocals),
  metadata: compile('template/metadata.pug', subdirLocals),
  metadataLink: compile('template/metadata-link.pug'),
  explore: compile('template/explore.pug', rootLocals),
  indexByCategory: compile('template/index-by-category.pug', rootLocals),
  indexByType: compile('template/index-by-type.pug', rootLocals),
}
