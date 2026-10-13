# Synthetic run-reader fixture

Every project, run, timestamp, decision, recovery and delivery record in this
directory is synthetic. These files exercise recorded state shapes only; they
are not observations from a real Development Cycle run or a reliability baseline.

The fixture contains two projects, five readable runs, one malformed run status,
and one directory without a status file. Run status records have `updatedAt`
because the current writer does not record run creation or launch timestamps.
Intervention artifacts contain the latest request, not a durable lifetime count.

The decision and plan bodies deliberately contain synthetic content that must
never appear in reader output. Symlinks, malformed optional files, retention and
standalone loading are exercised on temporary copies by the acceptance tests.
