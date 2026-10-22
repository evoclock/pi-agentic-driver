// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only

import { registerAidrInterface } from "../scripts/aidr_writing_review.js";

export default function registerAidr(pi: any) {
  return registerAidrInterface(pi);
}
