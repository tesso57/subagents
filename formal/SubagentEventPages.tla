-------------------------- MODULE SubagentEventPages ------------------------
EXTENDS Integers, Sequences

\* Coordinator.emit() appends one event at a time. Event IDs represent job
\* ownership; the rest of each entry is abstracted away. Positions are 1-based
\* here, while wait() uses its last-seen event number as a JavaScript index.
CONSTANTS JobIds, PageSize, MaxEvents
ASSUME Parameters == PageSize \in Nat \ {0}

VARIABLES log, seen, cursor, response
vars == <<log, seen, cursor, response>>

Event == [seq: Nat, id: JobIds]

Positioned(history) ==
    /\ history \in Seq(Event)
    /\ \A i \in 1..Len(history) : history[i].seq = i

PageEnd(n, c) == IF c + PageSize < n THEN c + PageSize ELSE n
Page(history, c) == SubSeq(history, c + 1, PageEnd(Len(history), c))
NextCursor(page, c) == IF page = <<>> THEN c ELSE page[Len(page)].seq

Snapshot(history, c) ==
    LET page == Page(history, c)
        next == NextCursor(page, c)
    IN [events |-> page, cursor |-> next, hasMore |-> next < Len(history),
        logLength |-> Len(history)]

\* logLength is model-only bookkeeping: hasMore describes the captured
\* log, even if events are appended before the caller receives the response.
NoResponse == [events |-> <<>>, cursor |-> 0, hasMore |-> FALSE, logLength |-> -1]

WaitFields(ids, pending, terminal, delays, c) ==
    [questions |-> pending,
     done |-> ids \cap terminal,
     stopDelayed |-> {e \in delays : e.id \in ids /\ e.seq > c}]

Ready(fields) ==
    \/ fields.questions # {}
    \/ fields.done # {}
    \/ fields.stopDelayed # {}

\* A snapshot may see any of these readiness witnesses. One witness suffices
\* for the disjunction in wait(). The job lifecycle, multiplicity of questions,
\* exact summary ordering, and wake/abort behavior are outside this model.
MayReturn(history, c, ids) ==
    \E i \in 1..Len(history) :
        LET event == history[i] IN
            \/ Ready(WaitFields(ids, {event.id}, {}, {}, c))
            \/ Ready(WaitFields(ids, {}, {event.id}, {}, c))
            \/ Ready(WaitFields(ids, {}, {}, {event}, c))

Init ==
    /\ log = <<>>
    /\ seen = <<>>
    /\ cursor = 0
    /\ response = NoResponse

AddEvent(id) ==
    /\ id \in JobIds
    /\ Len(log) < MaxEvents
    /\ log' = Append(log, [seq |-> Len(log) + 1, id |-> id])
    /\ UNCHANGED <<seen, cursor, response>>

\* The return branch of wait() captures its page and metadata synchronously.
\* A successful poll uses known IDs; their order and repetition affect only
\* the side fields in the real response. A blocked poll can leave state unchanged.
TakeSnapshot(ids) ==
    /\ response = NoResponse
    /\ ids # {}
    /\ ids \subseteq JobIds
    /\ MayReturn(log, cursor, ids)
    /\ response' = Snapshot(log, cursor)
    /\ UNCHANGED <<log, seen, cursor>>

\* One reader accepts one response at a time and reuses its returned cursor.
Deliver ==
    /\ response # NoResponse
    /\ seen' = seen \o response.events
    /\ cursor' = response.cursor
    /\ response' = NoResponse
    /\ UNCHANGED log

Next ==
    \/ \E id \in JobIds : AddEvent(id)
    \/ \E ids \in SUBSET JobIds : TakeSnapshot(ids)
    \/ Deliver

Spec == Init /\ [][Next]_vars

Prefix ==
    /\ Positioned(log)
    /\ seen \in Seq(Event)
    /\ cursor = Len(seen)
    /\ cursor \in 0..Len(log)
    /\ \A i \in 1..cursor : seen[i] = log[i]

ResponseValid(history, c, r) ==
    /\ r.logLength \in c..Len(history)
    /\ r.cursor = PageEnd(r.logLength, c)
    /\ r.events \in Seq(Event)
    /\ Len(r.events) = r.cursor - c
    /\ \A i \in 1..Len(r.events) : r.events[i] = history[c + i]
    /\ r.hasMore = (r.cursor < r.logLength)

Safety == Prefix /\ (response # NoResponse => ResponseValid(log, cursor, response))
=============================================================================
