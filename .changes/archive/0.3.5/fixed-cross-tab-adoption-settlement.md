---
kind: fixed
summary: cross-tab followers now settle safely when token adoption fails
---

A throwing `onTokenReceived` callback now produces an immediate failed refresh
outcome for the follower without leaving it waiting or causing a redundant
refresh request.
