let showdown = require('showdown')

let showdownConverter = new showdown.Converter()
showdownConverter.setOption('simplifiedAutoLink', true)

module.exports = page=>{
  let textMarkdown = page.text
  return showdownConverter.makeHtml(textMarkdown)
}
