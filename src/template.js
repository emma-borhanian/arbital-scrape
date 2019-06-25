let pug = require('pug')

let compile =(file, defaultLocals={}) => {
  let f = pug.compileFile(file)
  return locals=>f({...defaultLocals, ...locals})
}

let rootLocals = { 'root': '' }
let subdirLocals = { 'root': '../' }

module.exports = {
  page: compile('template/page.pug', subdirLocals),
  index: compile('template/index.pug', rootLocals),
  debug: compile('template/debug.pug', rootLocals)
}
