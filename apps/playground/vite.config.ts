/*
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 * Modifications Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vitejs.dev/config/
// BUFI: the deployment file (contracts/deployments/local.json) and the forge artifacts (contracts/out) live
// outside this package; Vite already allows the whole bun workspace, so plain imports / import.meta.glob work
// in both `vite` and `vite build`.
export default defineConfig({
  plugins: [react()],
  server: {
    host: 'localhost',
    port: 5173,
  },
})
