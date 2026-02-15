use openjack::state::RoundStatus;

#[test]
fn status_flow_is_linear() {
    assert!(RoundStatus::Open.can_transition_to(RoundStatus::Closed));
    assert!(RoundStatus::Closed.can_transition_to(RoundStatus::Drawing));
    assert!(RoundStatus::Drawing.can_transition_to(RoundStatus::Settling));
    assert!(RoundStatus::Settling.can_transition_to(RoundStatus::Finalized));
}

#[test]
fn status_flow_rejects_skips() {
    assert!(!RoundStatus::Open.can_transition_to(RoundStatus::Settling));
    assert!(!RoundStatus::Closed.can_transition_to(RoundStatus::Finalized));
    assert!(!RoundStatus::Finalized.can_transition_to(RoundStatus::Open));
}
