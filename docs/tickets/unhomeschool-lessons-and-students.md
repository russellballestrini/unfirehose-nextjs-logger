# unhomeschool-com: One-Time Lessons + Student Accounts

**Repo:** unhomeschool-com
**Priority:** Medium
**Todo IDs:** 2532-2536, 2546-2548

## Features

### 1. One-Time Lessons (2532-2536)
- Update ScheduledLesson model for one-time (non-recurring) lessons
- SQLite migration script
- Route, view, and template for adding one-time lessons
- Update templates to use display_name and handle null course
- Update assignment views to handle null course

### 2. Student Account System (2546-2548)
- Add user_id and email columns to Student model
- Add request.student, is_student, is_parent + update request.family
- Add parent_required() decorator for access control

## Notes
One-time lessons allow scheduling field trips, guest speakers, etc. without requiring a full course. Student accounts let older students log in to see their own schedule/assignments with the parent_required() decorator protecting admin actions.
