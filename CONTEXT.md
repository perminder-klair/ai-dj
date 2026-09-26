# AI DJ

Music selection and spoken hosting for a nightclub event.

## Language

**Track**:
A recorded piece of music available for the DJ to select and play.

**Track metadata**:
Information describing a track that the DJ can use to choose music.

**DJ speech**:
Spoken audio from the AI DJ between tracks.

**Event pool**:
The approved collection of tracks the DJ may select for an event.
_Avoid_: Queue, playlist when referring to selection eligibility rather than playback order

**Request-only track**:
A song found outside the event pool in the full library and queued by an operator. The autonomous DJ and fallback do not select it.

**Operator**:
The person supervising the event who can override track selection and playback, and mute DJ speech.

**Event brief**:
The operator's initial description of the musical direction for the event.

**Steering instruction**:
A live instruction from the operator that changes the musical direction of upcoming selections.

**Fallback order**:
A prepared order of approved tracks used when the DJ cannot make a selection.

**Upcoming queue**:
The ordered tracks selected to play next. The operator can replace or reorder them until a transition to a track begins.
_Avoid_: Event pool

**Event**:
A supervised period of music playback with an approved event pool, musical direction, playback history, and planned end time.

**Protected selection**:
An upcoming track explicitly chosen or reordered by the operator. Automatic replanning preserves it.

**Preparation**:
The checks and local music collection needed to make an event ready for playback, including an eligible fallback order.
