---
description: "One dynamic tutor, many subject packs: tutors:coach plans today's training, tutors:coach <subject> [message] opens that coach"
backends: [claude, codex]
flags:
  init:
    type: boolean
    description: Seed .coach/ in the training root with the student profile and the built-in packs, then exit
  list:
    type: boolean
    description: Print the roster and exit
---
