-------------------------- MODULE SubagentCoordinator -------------------------
EXTENDS Naturals, FiniteSets

\* Coordinator in extensions/src/coordinator.ts. Steps describe the state after
\* synchronous updates. The runner is abstracted to a return or rejection after
\* its own cleanup. "stop_delayed" represents "stopping" with a recorded
\* delay. Time is abstracted to a timer callback; even a delayed runner can
\* stay active indefinitely if it never returns or rejects.
CONSTANTS JobIds, RequestIds, Limit
ASSUME Parameters == IsFiniteSet(JobIds) /\ Limit \in Nat \ {0}

VARIABLES state, questions, active, closed
vars == <<state, questions, active, closed>>

Final == {"completed", "failed", "stopped"}
Asking == {"running", "waiting_for_parent"}
Stoppable == Asking \cup {"starting"}
Stopping == {"stopping", "stop_delayed"}
Holding == Stoppable \cup Stopping
States == Final \cup Holding \cup {"unused", "queued"}
ClosedStates == Final \cup Stopping \cup {"unused"}
Holders == {id \in JobIds : state[id] \in Holding}

Init ==
    /\ state = [id \in JobIds |-> "unused"]
    /\ questions = [id \in JobIds |-> {}]
    /\ active = 0
    /\ closed = FALSE

Enqueue(id) ==
    /\ ~closed
    /\ state[id] = "unused"
    /\ state' = [state EXCEPT ![id] = "queued"]
    /\ UNCHANGED <<questions, active, closed>>

\* pump() reserves a slot before the runner starts. Selecting any queued
\* job abstracts over FIFO order and overapproximates interleavings.
Acquire(id) ==
    /\ ~closed
    /\ state[id] = "queued"
    /\ active < Limit
    /\ active' = active + 1
    /\ state' = [state EXCEPT ![id] = "starting"]
    /\ UNCHANGED <<questions, closed>>

Launch(id) ==
    /\ state[id] = "starting"
    /\ state' = [state EXCEPT ![id] = "running"]
    /\ UNCHANGED <<questions, active, closed>>

Ask(id, request) ==
    /\ state[id] \in Asking
    /\ request \notin questions[id]
    /\ questions' = [questions EXCEPT ![id] = @ \cup {request}]
    /\ state' = [state EXCEPT ![id] = "waiting_for_parent"]
    /\ UNCHANGED <<active, closed>>

Reply(id, request) ==
    /\ request \in questions[id]
    /\ questions' = [questions EXCEPT ![id] = @ \ {request}]
    /\ state' = [state EXCEPT ![id] =
        IF questions'[id] = {} THEN "running" ELSE "waiting_for_parent"]
    /\ UNCHANGED <<active, closed>>

StopState(s) ==
    CASE s = "queued" -> "stopped"
      [] s \in Stoppable -> "stopping"
      [] OTHER -> s

Stop(id) ==
    /\ state[id] \in Stoppable \cup {"queued"}
    /\ state' = [state EXCEPT ![id] = StopState(@)]
    /\ questions' = [questions EXCEPT ![id] = {}]
    /\ UNCHANGED <<active, closed>>

ReportDelay(id) ==
    /\ state[id] = "stopping"
    /\ state' = [state EXCEPT ![id] = "stop_delayed"]
    /\ UNCHANGED <<questions, active, closed>>

\* The active counter is released in the runner's finally block.
\* A stop request retains the slot while the runner finishes cleanup.
Finish(id, failed) ==
    /\ state[id] \in Asking \cup Stopping
    /\ state' = [state EXCEPT ![id] =
        IF @ \in Stopping THEN "stopped"
        ELSE IF failed THEN "failed" ELSE "completed"]
    /\ questions' = [questions EXCEPT ![id] = {}]
    /\ active' = active - 1
    /\ UNCHANGED closed

\* Models the synchronous closed flag and stop loop of shutdown().
\* The runner's asynchronous cleanup remains a separate Finish transition.
Shutdown ==
    /\ ~closed
    /\ closed' = TRUE
    /\ state' = [id \in JobIds |-> StopState(state[id])]
    /\ questions' = [id \in JobIds |-> {}]
    /\ UNCHANGED active

Next ==
    \/ \E id \in JobIds :
        \/ Enqueue(id) \/ Acquire(id) \/ Launch(id) \/ Stop(id) \/ ReportDelay(id)
        \/ \E request \in RequestIds : Ask(id, request) \/ Reply(id, request)
        \/ \E failed \in BOOLEAN : Finish(id, failed)
    \/ Shutdown

\* A continuously enabled timer eventually runs if the event loop progresses.
\* There is no fairness assumption on Finish: a runner may ignore abort.
Spec == Init /\ [][Next]_vars /\ \A id \in JobIds : WF_vars(ReportDelay(id))

StopReports ==
    \A id \in JobIds : (state[id] = "stopping") ~> (state[id] \in Final \cup {"stop_delayed"})

\* shutdown resolves when no slots are held or rejects when all remaining
\* holders have exceeded their stop deadline. Rejection retains the slots.
ShutdownReports == closed ~> (\A id \in Holders : state[id] = "stop_delayed")

Control ==
    /\ state \in [JobIds -> States]
    /\ questions \in [JobIds -> SUBSET RequestIds]
    /\ closed \in BOOLEAN
    /\ \A id \in JobIds : (questions[id] # {} <=> state[id] = "waiting_for_parent")
    /\ closed => \A id \in JobIds : state[id] \in ClosedStates

Capacity ==
    /\ active \in 0..Limit
    /\ active = Cardinality(Holders)

Safety == Control /\ Capacity
=============================================================================
