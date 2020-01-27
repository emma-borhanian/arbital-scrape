let pug = require('pug')
let dateFormat = require('dateformat')
let changeCase = require('change-case')
let path = require('path')
let util = require('util')

let config = require('../config.js')
let lib = require('./lib.js')

let compile =(file, defaultLocals={}) => {
  let f = pug.compileFile(file)
  return locals=>f({...defaultLocals, ...locals, pugTemplate: path.basename(file)})
}

module.exports = (argv)=>{
  let locals = {
    argv:argv, lib:lib, config:config, dateFormat:dateFormat, changeCase:changeCase, path:path, util:util,
    fileLink:file=>path.relative(argv.directory, file),
  }
  let rootLocals = { ...locals, 'root': '' }
  let subdirLocals = { ...locals, 'root': '../' }

  return {
    page: compile('template/page.pug', subdirLocals),
    pageDiff: compile('template/page-diff.pug', subdirLocals),
    index: compile('template/index.pug', rootLocals),
    debug: compile('template/debug.pug', rootLocals),
    debugAllMathjax: compile('template/debug-all-mathjax.pug', rootLocals),
    metadata: compile('template/metadata.pug', subdirLocals),
    metadataLink: compile('template/metadata-link.pug'),
    explore: compile('template/explore.pug', rootLocals),
    indexByCategory: compile('template/index-by-category.pug', rootLocals),
    indexByType: compile('template/index-by-type.pug', rootLocals),
  }
}
