import React, { useEffect, useState } from 'react'
import { API_BASE } from '../backendRuntime'


const DownloadQueue = ({ theme }) => {
    const [tasks, setTasks] = useState([])

    useEffect(() => {
        const fetchTasks = async () => {
            try {
                const res = await fetch(`${API_BASE}/api/remote/tasks`)
                if (res.ok) {
                    setTasks(await res.json())
                }
            } catch (e) {
                console.error("Failed to fetch download tasks", e)
            }
        }

        fetchTasks()
        const interval = setInterval(fetchTasks, 2000)
        return () => clearInterval(interval)
    }, [])

    if (tasks.length === 0) return null

    const isLight = theme === 'light'

    return (
        <div className={`fixed bottom-4 right-4 w-80 p-4 rounded-lg shadow-lg border ${isLight ? 'bg-white border-gray-200' : 'bg-gray-800 border-gray-700'
            }`}>
            <h3 className={`font-semibold mb-2 ${isLight ? 'text-gray-900' : 'text-gray-100'}`}>Downloads</h3>
            <div className="space-y-3 max-h-60 overflow-y-auto">
                {tasks.map(task => (
                    <div key={task.id} className="text-sm">
                        <div className="flex justify-between mb-1">
                            <span className={`truncate ${isLight ? 'text-gray-700' : 'text-gray-300'}`} title={task.filename}>
                                {task.filename}
                            </span>
                            <span className={`text-xs ${task.status === 'completed' ? 'text-green-500' :
                                task.status === 'failed' ? 'text-red-500' :
                                    'text-blue-500'
                                }`}>
                                {task.status}
                            </span>
                        </div>
                        {task.status === 'downloading' && (
                            <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-gray-700">
                                <div
                                    className="bg-blue-600 h-1.5 rounded-full"
                                    style={{ width: `${(task.progress || 0) * 100}%` }}
                                ></div>
                            </div>
                        )}
                        {task.error && (
                            <p className="text-xs text-red-500 mt-1">{task.error}</p>
                        )}
                    </div>
                ))}
            </div>
        </div>
    )
}

export default DownloadQueue
