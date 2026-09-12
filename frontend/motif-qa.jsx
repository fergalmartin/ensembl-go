import React from 'react'
import {createRoot} from 'react-dom/client'
import AlignmentExplorerView from './src/components/alignment-explorer/AlignmentExplorerView'
import './src/index.css'
const nativeFetch=window.fetch.bind(window)
window.fetch=(input,options)=>nativeFetch(typeof input==='string'?input.replace('http://127.0.0.1:8000','http://127.0.0.1:8011'):input,options)
createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex',background:'#152032'}}><AlignmentExplorerView theme="dark" config={{}}/></div>)
