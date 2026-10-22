// SPDX-FileCopyrightText: 2026 evoclock
// SPDX-License-Identifier: AGPL-3.0-only

import { registerHarvestLessons } from "../scripts/harvest_lessons.js";

export default function registerHarvestLessonsExtension(pi: any) {
  return registerHarvestLessons(pi);
}
