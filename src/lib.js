let config = require('../config.js')

module.exports = {
  maxBy: (os,f)=> {
    os = os.map(o=>[o,f(o)])
    let max = Math.max(...os.map(o=>o[1]))
    for (let o of os) { if (max == o[1]) return o[0] }
  },
  sortBy: (array,f)=>array.sort((a,b)=>{ a = f(a); b = f(b); return a<b?-1:a==b?0:1 }),
  makePagesByType: (pages, pageIndex)=>{
    pages = Array.from(pages).map(p=>pageIndex[p]||p)
    let pagesByType = {}
    for (let page of pages) {
      page = pageIndex[page] || page
      let type = typeof(page)=='string' ? config.defaultTypeString : page.type
      ;(pagesByType[type]=pagesByType[type]||[]).push(page)
    }
    return module.exports.sortBy(Object.entries(pagesByType), e=>config.typeSortOrder.indexOf(e[0]))
  },
}
