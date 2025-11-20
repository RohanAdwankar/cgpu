CLI enabling free cloud GPU access in your terminal for learning CUDA.

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

