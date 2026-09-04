
test('Next cannot advance twice when the action it performed already advanced the step', () => {
  // Pressing Next on "open Configuration" navigates, which is what that step was waiting
  // for. The follow-up must be ignored, or the step after it is skipped unseen.
  const start = run(initTutorialState(tutorial), { type: 'next' })
  assert.equal(currentStep(tutorial, start).id, 'open-config')

  const afterNavigate = reduceTutorial(tutorial, start, { type: 'view', view: 'configuration' })
  assert.equal(currentStep(tutorial, afterNavigate).id, 'save')

  const stale = reduceTutorial(tutorial, afterNavigate, { type: 'next', fromStepId: 'open-config' })
  assert.equal(stale, afterNavigate, 'a Next from a step we have left is ignored')
})

test('an untagged Next still advances, and a matching one advances once', () => {
  const state = initTutorialState(tutorial)
  assert.equal(reduceTutorial(tutorial, state, { type: 'next' }).stepIndex, 1)
  assert.equal(reduceTutorial(tutorial, state, { type: 'next', fromStepId: 'intro' }).stepIndex, 1)
})
