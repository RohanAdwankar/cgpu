### CLI enabling free cloud GPU access in your terminal for learning CUDA

![nvcc demo](docs/demo.gif)

```bash
# Install cgpu
npm i -g cgpu
# First run will launch an interactive setup wizard
# Connect to a cloud GPU instance quickly without setup any time after that
cgpu connect
# Run a command on a cloud GPU instance without a persistent terminal (but mantaining file system state)
cgpu run nvidia-smi 
```

https://github.com/user-attachments/assets/93158031-24fd-4a63-a4cb-1164bea383c3

### Vision
The primary goal of this project to facilitate a high quality developer experience for those without GPUs who would like to learn CUDA C++
This means 3 main things:
1. Free: Avoid having to pay while learning.
2. Highly Available: Run quickly instead of having to wait in a queue so that users can compile quickly and learn faster.
3. In User Terminal: Allows developers to use their own devtools/IDEs (Neovim, Cursor, etc) so they can be most productive.

### Next Steps
I will continue to add to the CLI as I find more free compute sources and developer experience improvements.
To see what I am currently planning to add check out the Issues tab on Github.
Feel free to create new Issues for suggestions/problems you run into while learning!
