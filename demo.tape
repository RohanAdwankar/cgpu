Output demo.gif
Set FontSize 16
Set Width 1200
Set Height 800
Set Shell bash

Type "cat ~/cuda2/vadd.cu | head -14"
Enter
Sleep 1s

Type "cgpu copy ~/cuda2/vadd.cu"
Enter
Sleep 2s

Type "cgpu run nvcc -arch=sm_75 -code=sm_75 -o vadd /content/vadd.cu"
Enter
Sleep 3s

Type "cgpu run ./vadd"
Enter
Sleep 2s

Type "cgpu connect"
Enter
Sleep 1s

Type "ls"
Enter
Sleep 1s

Type "nvidia-smi"
Enter
Sleep 2s
