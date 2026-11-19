---------------------- MODULE SubagentEventPagesProofs -----------------------
EXTENDS SubagentEventPages, SequenceTheorems, TLAPS

LEMMA PageEndBounds ==
    ASSUME NEW n \in Nat, NEW c \in 0..n
    PROVE /\ PageEnd(n,c) \in c..n
          /\ PageEnd(n,c) - c \in 0..PageSize
          /\ (PageEnd(n,c) = c) <=> (n = c)
          /\ (PageEnd(n,c) - c = PageSize) <=> (n - c >= PageSize)
          /\ (PageEnd(n,c) < n) <=> (n - c > PageSize)
    BY Parameters, SMT DEF PageEnd

LEMMA PageProperties ==
    ASSUME NEW history \in Seq(Event), NEW c \in 0..Len(history)
    PROVE /\ Page(history,c) \in Seq(Event)
          /\ Len(Page(history,c)) = PageEnd(Len(history),c) - c
          /\ \A i \in 1..Len(Page(history,c)) : Page(history,c)[i] = history[c+i]
<1>1. PageEnd(Len(history),c) \in c..Len(history)
    BY LenProperties, PageEndBounds, SMT
<1>2. \A i \in (c+1)..PageEnd(Len(history),c) : history[i] \in Event
    BY <1>1, ElementOfSeq, SMT
<1> QED BY <1>1, <1>2, SubSeqProperties, SMT DEF Page

LEMMA SnapshotValid ==
    ASSUME NEW history, Positioned(history), NEW c \in 0..Len(history)
    PROVE ResponseValid(history,c,Snapshot(history,c))
<1> DEFINE p == Page(history,c)
           e == PageEnd(Len(history),c)
<1>1. /\ e \in c..Len(history)
      /\ p \in Seq(Event)
      /\ Len(p) = e - c
      /\ \A i \in 1..Len(p) : p[i] = history[c+i]
    BY PageProperties, PageEndBounds, LenProperties, SMT DEF Positioned, p, e
<1>2. NextCursor(p,c) = e
    <2>1. CASE p = <<>>
        BY <1>1, <2>1, EmptySeq, SMT DEF NextCursor
    <2>2. CASE p # <<>>
        <3>1. Len(p) \in Nat \ {0}
            BY <1>1, <2>2, EmptySeq, SMT
        <3>2. c + Len(p) \in 1..Len(history)
            BY <1>1, <3>1, LenProperties, SMT DEF Positioned
        <3>3. p[Len(p)].seq = c + Len(p)
            BY <1>1, <3>1, <3>2, SMT DEF Positioned
        <3> QED BY <1>1, <2>2, <3>3, SMT DEF NextCursor
    <2> QED BY <2>1, <2>2
<1> QED BY <1>1, <1>2, LenProperties, SMT DEF Snapshot, ResponseValid, Positioned, p, e

THEOREM SnapshotBoundaries ==
    ASSUME NEW history, Positioned(history), NEW c \in 0..Len(history)
    PROVE LET r == Snapshot(history,c) IN
          /\ Len(r.events) \in 0..PageSize
          /\ (r.events = <<>>) <=> (c = Len(history))
          /\ (r.cursor = c) <=> (c = Len(history))
          /\ (Len(r.events) = PageSize) <=> (Len(history)-c >= PageSize)
          /\ r.hasMore <=> (Len(history)-c > PageSize)
<1> DEFINE r == Snapshot(history,c)
<1>1. ResponseValid(history,c,r)
    BY SnapshotValid DEF r
<1>2. r.logLength = Len(history)
    BY SMT DEF r, Snapshot
<1>3. (Len(r.events) = 0) <=> (r.events = <<>>)
    BY <1>1, EmptySeq, SMT DEF ResponseValid
<1> QED BY <1>1, <1>2, <1>3, PageEndBounds, LenProperties, SMT
        DEF ResponseValid, Positioned, r

LEMMA AppendPositioned ==
    ASSUME NEW history, Positioned(history), NEW id \in JobIds
    PROVE LET extended == Append(history,[id |-> id, seq |-> Len(history)+1]) IN
          /\ Positioned(extended)
          /\ Len(extended) = Len(history)+1
          /\ \A i \in 1..Len(history) : extended[i] = history[i]
<1> DEFINE event == [id |-> id, seq |-> Len(history)+1]
           extended == Append(history,event)
<1>1. event \in Event
    BY LenProperties, SMT DEF Positioned, Event, event
<1>2. /\ extended \in Seq(Event)
      /\ Len(extended) = Len(history)+1
      /\ \A i \in 1..Len(history) : extended[i] = history[i]
      /\ extended[Len(history)+1] = event
    BY <1>1, AppendProperties, SMT DEF Positioned, extended
<1> QED BY <1>2, LenProperties, SMT DEF Positioned, extended, event

LEMMA InitialSafety == Init => Safety
    BY EmptySeq, SMT DEF Init, Safety, Prefix, Positioned, NoResponse

LEMMA AppendPreserves ==
    ASSUME Safety, NEW id \in JobIds, AddEvent(id)
    PROVE Safety'
<1>1. /\ Positioned(log')
      /\ Len(log') = Len(log)+1
      /\ \A i \in 1..Len(log) : log'[i] = log[i]
    BY AppendPositioned, SMT DEF Safety, Prefix, AddEvent
<1>2. Len(log) \in Nat /\ cursor \in 0..Len(log')
    BY <1>1, LenProperties, SMT DEF Safety, Prefix, Positioned
<1>3. Prefix'
    BY <1>1, <1>2, SMT DEF Safety, Prefix, AddEvent
<1>4. response' # NoResponse => ResponseValid(log',cursor',response')
    <2>1. ASSUME response' # NoResponse PROVE ResponseValid(log',cursor',response')
        <3>1. ResponseValid(log,cursor,response)
            BY <2>1, SMT DEF Safety, AddEvent
        <3>2. response.logLength \in cursor..Len(log')
          /\ \A i \in 1..Len(response.events) : cursor+i \in 1..Len(log)
            BY <1>1, <1>2, <3>1, Parameters, SMT DEF Safety, Prefix, ResponseValid, PageEnd
        <3> QED BY <1>1, <3>1, <3>2, SMT DEF ResponseValid, AddEvent
    <2> QED BY <2>1
<1> QED BY <1>3, <1>4 DEF Safety

LEMMA SnapshotPreserves ==
    ASSUME Safety, NEW ids \in SUBSET JobIds, TakeSnapshot(ids)
    PROVE Safety'
<1>1. Prefix'
    BY DEF Safety, Prefix, TakeSnapshot
<1>2. ResponseValid(log',cursor',response')
    BY SnapshotValid, SMT DEF Safety, Prefix, TakeSnapshot
<1> QED BY <1>1, <1>2 DEF Safety

LEMMA DeliveryPreserves ==
    ASSUME Safety, Deliver
    PROVE Safety'
<1>1. Prefix /\ ResponseValid(log,cursor,response)
    BY DEF Safety, Deliver
<1>2. /\ seen' \in Seq(Event)
      /\ Len(seen') = cursor + Len(response.events)
      /\ \A i \in 1..Len(seen') :
            seen'[i] = IF i <= cursor THEN seen[i] ELSE response.events[i-cursor]
    BY <1>1, ConcatProperties, SMT DEF Prefix, ResponseValid, Deliver
<1>3. Len(seen') = cursor' /\ cursor' \in 0..Len(log')
    BY <1>1, <1>2, Parameters, LenProperties, SMT DEF Prefix, Positioned, ResponseValid, Deliver, PageEnd
<1>4. \A i \in 1..cursor' : seen'[i] = log'[i]
    BY <1>1, <1>2, <1>3, SMT DEF Prefix, ResponseValid, Deliver
<1> QED BY <1>2, <1>3, <1>4, SMT DEF Safety, Prefix, Deliver

THEOREM EventPagesSafety == Spec => []Safety
<1>1. Safety /\ [Next]_vars => Safety'
    <2>1. Safety /\ Next => Safety'
        BY AppendPreserves, SnapshotPreserves, DeliveryPreserves DEF Next
    <2>2. Safety /\ UNCHANGED vars => Safety'
        BY DEF vars, Safety, Prefix, Positioned, ResponseValid
    <2> QED BY <2>1, <2>2
<1> QED BY PTL, InitialSafety, <1>1 DEF Spec
=============================================================================
