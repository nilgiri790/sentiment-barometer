#!/bin/bash
# Double-click if you forgot the admin password of the "Manage API Keys" page.
# It asks for a new password and updates the website. Saved API keys stay as they are.
RESET_PASSWORD=1 exec "$(dirname "$0")/Deploy.command"
