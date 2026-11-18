----------------------- MODULE SubagentCoordinatorProofs ----------------------
EXTENDS SubagentCoordinator, FiniteSetTheorems, TLAPS

LEMMA InitialSafety == Init => Safety
<1>1. Init => Control
    BY SMT
        DEF Init, Safety, Control, Capacity, Holders, States, ClosedStates, Final, Holding, Stoppable, Stopping, Asking
<1>2. Init => Holders = {}
    BY SMT DEF Init, Holders, Holding, Stoppable, Stopping, Asking
<1>3. Init => active \in 0..Limit
    BY Parameters, SMT DEF Init
<1> QED BY <1>1, <1>2, <1>3, FS_EmptySet DEF Init, Safety, Capacity

LEMMA ControlPreserved == Control /\ Next => Control'
<1>1. ASSUME Control, NEW id \in JobIds, Enqueue(id) \/ Acquire(id) \/ Launch(id)
      PROVE Control'
    BY Control, Enqueue(id) \/ Acquire(id) \/ Launch(id), SMT
        DEF Enqueue, Acquire, Launch, Control, States, ClosedStates, Final, Holding, Stoppable, Stopping, Asking
<1>2. ASSUME Control, NEW id \in JobIds, NEW request \in RequestIds, Ask(id, request) \/ Reply(id, request)
      PROVE Control'
    BY Control, Ask(id, request) \/ Reply(id, request), SMT
        DEF Ask, Reply, Control, States, ClosedStates, Final, Holding, Stoppable, Stopping, Asking
<1>3. ASSUME Control, NEW id \in JobIds, Stop(id) PROVE Control'
    BY Control, Stop(id), SMT
        DEF Stop, StopState, Control, States, ClosedStates, Final, Holding, Stoppable, Stopping, Asking
<1>4. ASSUME Control, NEW id \in JobIds, NEW failed \in BOOLEAN, Finish(id, failed) PROVE Control'
    BY Control, Finish(id, failed), SMT
        DEF Finish, Control, States, ClosedStates, Final, Holding, Stoppable, Stopping, Asking
<1>5. ASSUME Control, NEW id \in JobIds, ReportDelay(id) PROVE Control'
    BY Control, ReportDelay(id), SMT
        DEF ReportDelay, Control, States, ClosedStates, Final, Holding, Stoppable, Stopping, Asking
<1>6. Control /\ Shutdown => Control'
    BY SMT DEF Shutdown, StopState, Control, States, ClosedStates, Final, Holding, Stoppable, Stopping, Asking
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5, <1>6 DEF Next

LEMMA HoldersFinite == IsFiniteSet(Holders)
    BY Parameters, FS_Subset, SMT DEF Holders

LEMMA CapacityPreserved == Safety /\ Next => Capacity'
<1>1. ASSUME Safety, NEW id \in JobIds, Acquire(id) PROVE Capacity'
    <2>1. Holders' = Holders \cup {id} /\ id \notin Holders
        BY Safety, Acquire(id), SMT DEF Safety, Control, Holders, Acquire, Holding, Stoppable, Stopping, Asking
    <2>2. Cardinality(Holders') = Cardinality(Holders) + 1
        BY <2>1, HoldersFinite, FS_AddElement, SMT
    <2>3. active' \in 0..Limit
        BY Parameters, Safety, Acquire(id), SMT DEF Safety, Capacity, Acquire
    <2> QED BY Safety, Acquire(id), <2>2, <2>3 DEF Safety, Capacity, Acquire
<1>2. ASSUME Safety, NEW id \in JobIds, NEW failed \in BOOLEAN, Finish(id, failed) PROVE Capacity'
    <2>1. Holders' = Holders \ {id} /\ id \in Holders
        BY Safety, Finish(id, failed), SMT DEF Safety, Control, Holders, Finish, Holding, Stoppable, Stopping, Asking
    <2>2. Cardinality(Holders') = Cardinality(Holders) - 1 /\ Cardinality(Holders) # 0
        BY <2>1, HoldersFinite, FS_RemoveElement, FS_EmptySet, SMT
    <2>3. active' \in 0..Limit
        BY Parameters, Safety, Finish(id, failed), <2>2, SMT DEF Safety, Capacity, Finish
    <2> QED BY Safety, Finish(id, failed), <2>2, <2>3 DEF Safety, Capacity, Finish
<1>3. ASSUME Safety, NEW id \in JobIds, Enqueue(id) \/ Launch(id) \/ Stop(id) \/ ReportDelay(id) PROVE Capacity'
    <2>1. Holders' = Holders /\ active' = active
        BY Safety, Enqueue(id) \/ Launch(id) \/ Stop(id) \/ ReportDelay(id), SMT
            DEF Safety, Control, Holders, Enqueue, Launch, Stop, StopState, ReportDelay, Holding, Stoppable, Stopping, Asking
    <2> QED BY Safety, <2>1 DEF Safety, Capacity
<1>4. ASSUME Safety, NEW id \in JobIds, NEW request \in RequestIds, Ask(id, request) \/ Reply(id, request) PROVE Capacity'
    <2>1. Holders' = Holders /\ active' = active
        BY Safety, Ask(id, request) \/ Reply(id, request), SMT
            DEF Safety, Control, Holders, Ask, Reply, Holding, Stoppable, Stopping, Asking
    <2> QED BY Safety, <2>1 DEF Safety, Capacity
<1>5. Safety /\ Shutdown => Capacity'
    <2>1. Shutdown => Holders' = Holders /\ active' = active
        BY SMT DEF Shutdown, StopState, Holders, Holding, Stoppable, Stopping, Asking
    <2> QED BY <2>1 DEF Safety, Capacity
<1> QED BY <1>1, <1>2, <1>3, <1>4, <1>5 DEF Next

THEOREM CoordinatorSafety == Spec => []Safety
<1>1. Safety /\ [Next]_vars => Safety'
    <2>1. Safety /\ Next => Safety'
        BY ControlPreserved, CapacityPreserved DEF Safety
    <2>2. Safety /\ UNCHANGED vars => Safety'
        BY DEF vars, Safety, Control, Capacity, Holders
    <2> QED BY <2>1, <2>2
<1> QED BY PTL, InitialSafety, <1>1 DEF Spec
=============================================================================
