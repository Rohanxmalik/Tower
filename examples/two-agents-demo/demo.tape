# Render the real animated GIF with charmbracelet/vhs:
#   vhs examples/two-agents-demo/demo.tape   →   docs/demo.gif
# Install vhs: https://github.com/charmbracelet/vhs
Output docs/demo.gif

Set Shell bash
Set FontSize 16
Set Width 1100
Set Height 640
Set Theme "Github Dark"
Set Padding 20

# Build quietly off-camera.
Hide
Type "npm run build > /dev/null 2>&1" Enter
Sleep 4s
Show

Type "node examples/two-agents-demo/demo.mjs" Enter
Sleep 7s
