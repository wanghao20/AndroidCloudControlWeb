package com.wanghaonetcn.Accessibility.myclass

import androidx.room.*
import com.wanghaonetcn.Accessibility.mybean.*

@Dao
interface DataDao {

    @Query("SELECT * FROM AppDescribe")
    fun getAllAppDescribes(): List<AppDescribe>

    @Query("SELECT * FROM AppDescribe WHERE appPackage = :appPackage")
    fun getAppDescribeByPackage(appPackage: String): AppDescribe?

    @Query("SELECT * FROM AutoFinder WHERE appPackage = :appPackage")
    fun getAutoFinderByPackage(appPackage: String): AutoFinder?

    @Query("SELECT * FROM Coordinate WHERE appPackage = :appPackage")
    fun getCoordinatesByPackage(appPackage: String): List<Coordinate>

    @Query("SELECT * FROM Widget WHERE appPackage = :appPackage")
    fun getWidgetsByPackage(appPackage: String): List<Widget>

    @Query("SELECT * FROM MyAppConfig WHERE id = 0")
    fun getMyAppConfig(): MyAppConfig?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertAppDescribe(vararg appDescribes: AppDescribe)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertAppDescribe(appDescribes: List<AppDescribe>)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertAutoFinder(vararg autoFinders: AutoFinder)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertAutoFinder(autoFinders: List<AutoFinder>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertCoordinate(vararg coordinates: Coordinate)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertWidget(vararg widgets: Widget)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    fun insertMyAppConfig(myAppConfig: MyAppConfig)

    @Delete
    fun deleteCoordinate(vararg coordinates: Coordinate)

    @Delete
    fun deleteWidget(vararg widgets: Widget)

    @Update
    fun updateCoordinate(vararg coordinates: Coordinate)

    @Update
    fun updateWidget(vararg widgets: Widget)

    @Update
    fun updateAutoFinder(vararg autoFinders: AutoFinder)

    @Update
    fun updateAppDescribe(vararg appDescribe: AppDescribe)

    @Update
    fun updateMyAppConfig(myAppConfig: MyAppConfig)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAppDescribeForce(appDescribes: List<AppDescribe>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertAutoFinderForce(autoFinders: List<AutoFinder>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertCoordinateForce(coordinates: List<Coordinate>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun insertWidgetForce(widgets: List<Widget>)
}
