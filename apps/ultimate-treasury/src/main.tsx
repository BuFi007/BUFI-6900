// SPDX-License-Identifier: Apache-2.0
import * as React from 'react'
import * as ReactDOM from 'react-dom/client'

import { App } from './app'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
