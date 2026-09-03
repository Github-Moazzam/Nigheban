"""
What the server does, with no HTTP attached.

A service function is callable from a route, from the sweeper, or from a test,
and does not know which one it is. That is the point of the layer: the sweeper
raises alerts nobody pressed a button for, and those have to travel exactly the
same path as a phone-raised one -- see emit_alert.
"""



