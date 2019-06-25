let showdown = require('showdown')

let renderPageLinks = require('./render-page-links.js')

let showdownConverter = new showdown.Converter()
showdownConverter.setOption('simplifiedAutoLink', true)

module.exports = (page, pageIndex, missingLinks=new Set())=>{
  let textMarkdown = page.text

  let getCanonicalPageKey = (key)=>{
    let canonPage = pageIndex[key.toLowerCase()]
    if (!canonPage) missingLinks.add(key)
    return canonPage ? canonPage.aliasOrId : key
  }

  textMarkdown = textMarkdown
    .replace(/https?:\/\/arbital.com\/p\/([^/\s.!?;:)\]]*)\/?/g, (_,m)=>`${getCanonicalPageKey(m)}.html`)

  textMarkdown = renderPageLinks(textMarkdown, pageIndex, missingLinks)
  return showdownConverter.makeHtml(textMarkdown)
}
